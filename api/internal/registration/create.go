package registration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/settings"
	"werun/api/internal/pricing"
	"werun/api/internal/registration/store"
	"werun/api/internal/runner"
)

var (
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	nationalityPattern    = regexp.MustCompile(`^[A-Z]{2}$`)
)

// normalizeCreateInput 做不依赖数据库的校验，并返回规范化后的副本（不修改入参）：
// 优惠码转大写、同意书勾选项排序、资料按 runner.NormalizeProfile 规范化（证件号去空白与连字符并转大写、国籍转大写等）、
// 选常用参赛人时 SaveAsProfile 归零。
func normalizeCreateInput(in CreateOrderInput) (CreateOrderInput, error) {
	fe := newFieldErrors()
	out := CreateOrderInput{
		EventSlug:      strings.TrimSpace(in.EventSlug),
		CouponCode:     strings.ToUpper(strings.TrimSpace(in.CouponCode)),
		IdempotencyKey: in.IdempotencyKey,
		Consent: runner.ConsentAcceptance{
			Version:      strings.TrimSpace(in.Consent.Version),
			Lang:         in.Consent.Lang,
			CheckedItems: slices.Sorted(slices.Values(in.Consent.CheckedItems)),
		},
	}
	if !idempotencyKeyPattern.MatchString(in.IdempotencyKey) {
		fe.add("idempotencyKey", "field.invalid", nil)
	}
	if out.EventSlug == "" {
		fe.add("eventSlug", "field.required", nil)
	}
	if n := len(in.Participants); n < MinParticipants || n > MaxParticipants {
		fe.add("participants", "field.invalid", nil)
	}
	out.Participants = make([]OrderParticipantInput, 0, len(in.Participants))
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		np := OrderParticipantInput{CategoryID: p.CategoryID}
		if p.CategoryID <= 0 {
			fe.add(prefix+"categoryId", "field.required", nil)
		}
		switch {
		case p.ProfileID != nil && p.Profile != nil:
			fe.add(prefix+"profileId", "field.invalid", nil)
		case p.ProfileID != nil:
			id := *p.ProfileID
			np.ProfileID = &id
		case p.Profile != nil:
			prof := runner.NormalizeProfile(*p.Profile)
			np.Profile = &prof
			np.SaveAsProfile = p.SaveAsProfile
			if err := fe.merge(runner.ValidateProfile(prof, prefix)); err != nil {
				return CreateOrderInput{}, err
			}
		default:
			fe.add(prefix+"profileId", "field.required", nil)
		}
		out.Participants = append(out.Participants, np)
	}
	if err := fe.result(); err != nil {
		return CreateOrderInput{}, err
	}
	return out, nil
}

// requestHash 是 requestHashPayload 的 SHA-256。结构体字段顺序固定，json.Marshal 输出稳定。
func requestHash(in CreateOrderInput, pii *piicrypt.Cipher) ([]byte, error) {
	raw, err := requestHashPayload(in, pii)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	return sum[:], nil
}

// requestHashPayload 返回参与幂等哈希的 JSON：规范化输入去掉幂等键，每位参赛人的证件号替换为
// hex(PII 密钥下的 HMAC)（与 registrations.id_no_hash 同一算法）。请求里其它字段在库里都有明文，
// 若哈希直接覆盖明文证件号，拿到数据库的人就能离线穷举证件号。不修改入参。
func requestHashPayload(in CreateOrderInput, pii *piicrypt.Cipher) ([]byte, error) {
	in.IdempotencyKey = ""
	parts := make([]OrderParticipantInput, len(in.Participants))
	for i, p := range in.Participants {
		if p.Profile != nil {
			prof := *p.Profile
			prof.IDNo = hex.EncodeToString(pii.Hash(prof.IDNo))
			p.Profile = &prof
		}
		parts[i] = p
	}
	in.Participants = parts
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("encode order request: %w", err)
	}
	return raw, nil
}

func registrationOpen(status, eventType string, open bool, opensAt, closesAt *time.Time, now time.Time) bool {
	return status == "PUBLISHED" && eventType == "RACE" && open &&
		(opensAt == nil || !opensAt.After(now)) &&
		(closesAt == nil || closesAt.After(now))
}

// CreateOrder 按 spec 6.1 在一个事务（默认 READ COMMITTED）里下单。同一跑者同一幂等键：请求体相同返回首次响应，
// 不同返回 IDEMPOTENCY_KEY_REUSED。
//
// 锁顺序（契约补充 6）：events 行 FOR SHARE → 幂等键行 → 证件号哈希 advisory 锁 → pricing.Quote 内的收款账户 advisory 锁
// → Reserve 更新的组别、价格档、优惠码行；订单在 Reserve 之后于同一事务写入，收款账户锁一直持有到提交。
func (s *Service) CreateOrder(ctx context.Context, u runner.User, in CreateOrderInput, meta httpx.Meta) (OrderDetail, error) {
	norm, err := normalizeCreateInput(in)
	if err != nil {
		return OrderDetail{}, err
	}
	hash, err := requestHash(norm, s.runners.PII())
	if err != nil {
		return OrderDetail{}, err
	}
	now := s.now().UTC()
	subject := fmt.Sprintf("user:%d", u.ID)

	var out OrderDetail
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		// 1. 先锁赛事行（FOR SHARE）：阻止后台同时关闭报名，又不让同一赛事的订单互相串行。
		ev, err := q.LockEventForOrder(ctx, norm.EventSlug)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %q: %w", norm.EventSlug, err)
		}
		replay, found, err := claimIdempotencyKey(ctx, q, subject, norm.IdempotencyKey, hash, now)
		if err != nil {
			return err
		}
		if found {
			out = replay
			return nil
		}
		detail, err := s.createOrderTx(ctx, tx, q, u, ev, norm, meta, now)
		if err != nil {
			return err
		}
		body, err := json.Marshal(toAPIOrderDetail(detail))
		if err != nil {
			return fmt.Errorf("encode idempotent response: %w", err)
		}
		if err := q.SaveIdempotencyResponse(ctx, store.SaveIdempotencyResponseParams{
			ResponseCode: http.StatusCreated,
			ResponseBody: body,
			Scope:        idempotencyScope,
			Subject:      subject,
			Key:          norm.IdempotencyKey,
		}); err != nil {
			return fmt.Errorf("save idempotent response: %w", err)
		}
		out = detail
		return nil
	})
	if err != nil {
		return OrderDetail{}, err
	}
	return out, nil
}

// claimIdempotencyKey 占用幂等键。返回 found=true 时 replay 是首次请求的响应。
func claimIdempotencyKey(ctx context.Context, q *store.Queries, subject, key string, hash []byte, now time.Time) (OrderDetail, bool, error) {
	_, err := q.ClaimIdempotencyKey(ctx, store.ClaimIdempotencyKeyParams{
		Key:         key,
		Scope:       idempotencyScope,
		Subject:     subject,
		RequestHash: hash,
		Now:         now,
		ExpiresAt:   now.Add(idempotencyTTL),
	})
	if err == nil {
		return OrderDetail{}, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, false, fmt.Errorf("claim idempotency key: %w", err)
	}
	row, err := q.GetIdempotencyKey(ctx, store.GetIdempotencyKeyParams{Scope: idempotencyScope, Subject: subject, Key: key})
	if err != nil {
		return OrderDetail{}, false, fmt.Errorf("load idempotency key: %w", err)
	}
	if !bytes.Equal(row.RequestHash, hash) {
		return OrderDetail{}, false, apperr.New(http.StatusUnprocessableEntity, apperr.CodeIdempotencyKeyReused)
	}
	if row.ResponseCode == nil {
		return OrderDetail{}, false, fmt.Errorf("idempotency key %q has no stored response", key)
	}
	var body apigen.OrderDetail
	if err := json.Unmarshal(row.ResponseBody, &body); err != nil {
		return OrderDetail{}, false, fmt.Errorf("decode idempotent response: %w", err)
	}
	return orderDetailFromAPI(body), true, nil
}

type resolvedParticipant struct {
	input   OrderParticipantInput
	profile runner.ProfileData // 已规范化
	idHash  []byte
}

func (s *Service) createOrderTx(ctx context.Context, tx pgx.Tx, q *store.Queries, u runner.User, ev store.LockEventForOrderRow,
	in CreateOrderInput, meta httpx.Meta, now time.Time) (OrderDetail, error) {
	// 1. 校验报名开放（赛事行已由调用方 FOR SHARE 锁住）
	if !registrationOpen(ev.Status, ev.EventType, ev.RegistrationOpen, ev.RegistrationOpensAt, ev.RegistrationClosesAt, now) {
		return OrderDetail{}, apperr.New(http.StatusConflict, apperr.CodeRegistrationClosed)
	}

	// 2. 参赛人资料与单内证件号去重（人数已在 normalizeCreateInput 校验）
	parts, err := s.resolveParticipants(ctx, tx, u, in)
	if err != nil {
		return OrderDetail{}, err
	}
	// 3. 同一赛事已报名
	if err := checkAlreadyRegistered(ctx, q, ev.ID, parts); err != nil {
		return OrderDetail{}, err
	}

	// 4. 收款账户
	accountID, err := q.SelectRegistrationPaymentAccount(ctx, ev.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, apperr.New(http.StatusServiceUnavailable, apperr.CodePaymentAccountUnavailable)
	}
	if err != nil {
		return OrderDetail{}, fmt.Errorf("select payment account: %w", err)
	}

	// 5–6. 算价（含识别分，Quote 内加收款账户 advisory 锁）与预留
	quoteIn := pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, CouponCode: in.CouponCode, Now: now, PaymentAccountID: &accountID}
	for _, p := range parts {
		quoteIn.Participants = append(quoteIn.Participants, pricing.ParticipantInput{
			CategoryID: p.input.CategoryID, Nationality: p.profile.Nationality, BirthDate: p.profile.BirthDate})
	}
	quote, err := s.prices.Quote(ctx, tx, quoteIn)
	if err != nil {
		return OrderDetail{}, err
	}
	if err := s.prices.Reserve(ctx, tx, quote); err != nil {
		return OrderDetail{}, err
	}

	// 7. 订单
	pay, err := settings.LoadPayment(ctx, tx)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("load payment settings: %w", err)
	}
	deadline := now.Add(pay.UploadWindow)
	buyer := parts[0].profile
	userID := u.ID
	var orderID int64
	err = idgen.Retry("reg_orders_order_no_key", func() error {
		return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
			id, err := store.New(sp).InsertRegOrder(ctx, store.InsertRegOrderParams{
				OrderNo:          idgen.Code(idgen.PrefixOrder),
				EventID:          ev.ID,
				BuyerUserID:      &userID,
				BuyerName:        buyer.FullName,
				BuyerPhoneE164:   buyer.Phone,
				BuyerEmail:       optString(buyer.Email),
				ListAmountCents:  quote.ListAmountCents,
				DiscountCents:    quote.DiscountCents,
				IdentOffsetCents: int16(quote.IdentOffsetCents),
				AmountCents:      quote.AmountCents,
				CouponID:         quote.CouponID,
				PaymentAccountID: &accountID,
				DeadlineAt:       &deadline,
			})
			orderID = id
			return err
		})
	})
	if err != nil {
		return OrderDetail{}, fmt.Errorf("insert order: %w", err)
	}

	// 8. 参赛人快照、报名、常用参赛人
	for i, p := range parts {
		pq := quote.Participants[i]
		opID, err := q.InsertOrderParticipant(ctx, store.InsertOrderParticipantParams{
			OrderID:        orderID,
			CategoryID:     pq.CategoryID,
			PriceRuleID:    pq.PriceRuleID,
			Audience:       pq.Audience,
			ListPriceCents: pq.ListPriceCents,
			PaidCents:      pq.PaidCents,
			SnapshotName:   p.profile.FullName,
		})
		if err != nil {
			return OrderDetail{}, fmt.Errorf("insert order participant: %w", err)
		}
		enc, err := s.runners.PII().Encrypt(p.profile.IDNo)
		if err != nil {
			return OrderDetail{}, fmt.Errorf("encrypt id number: %w", err)
		}
		if err := insertRegistration(ctx, tx, store.InsertRegistrationParams{
			OrderParticipantID: opID,
			EventID:            ev.ID,
			CategoryID:         pq.CategoryID,
			UserID:             &userID,
			FullName:           p.profile.FullName,
			Gender:             p.profile.Gender,
			BirthDate:          p.profile.BirthDate,
			Nationality:        p.profile.Nationality,
			IDType:             optString(p.profile.IDType),
			IDNoEnc:            enc,
			IDNoHash:           p.idHash,
			PhoneE164:          optString(p.profile.Phone),
			Email:              optString(p.profile.Email),
			EmergencyName:      optString(p.profile.EmergencyName),
			EmergencyPhone:     optString(p.profile.EmergencyPhone),
			TshirtSize:         optString(p.profile.TShirtSize),
		}); err != nil {
			return OrderDetail{}, err
		}
		if p.input.SaveAsProfile && p.input.Profile != nil {
			if _, err := s.runners.CreateProfileTx(ctx, tx, u, p.profile); err != nil {
				return OrderDetail{}, err
			}
		}
	}

	// 9. 优惠码核销
	if err := s.prices.RecordRedemption(ctx, tx, orderID, quote); err != nil {
		return OrderDetail{}, err
	}
	// 10. 同意书
	if err := s.runners.SignConsent(ctx, tx, u, in.Consent, meta, runner.ConsentLink{RegOrderID: &orderID}); err != nil {
		return OrderDetail{}, err
	}
	// 11. 审计（不含参赛人资料与证件号）
	after := map[string]any{
		"couponCode":       in.CouponCode,
		"participants":     len(parts),
		"listAmountCents":  quote.ListAmountCents,
		"discountCents":    quote.DiscountCents,
		"identOffsetCents": quote.IdentOffsetCents,
		"amountCents":      quote.AmountCents,
		"paymentAccountId": accountID,
	}
	if err := audit.Record(ctx, tx, runnerAudit(u, "reg_order.create", orderID, ev.ID,
		fmt.Sprintf("跑者下单（%d 人，应付 %d 分）", len(parts), quote.AmountCents), after, meta)); err != nil {
		return OrderDetail{}, err
	}
	// 12. 应付为 0 直接确认
	if quote.AmountCents == 0 {
		if err := s.ConfirmPaid(ctx, tx, orderID, now); err != nil {
			return OrderDetail{}, err
		}
		if err := audit.Record(ctx, tx, runnerAudit(u, "reg_order.paid_zero", orderID, ev.ID,
			"应付为 0，订单直接确认", map[string]any{"status": StatusPaid}, meta)); err != nil {
			return OrderDetail{}, err
		}
	}
	return s.loadDetail(ctx, q, orderID)
}

func (s *Service) resolveParticipants(ctx context.Context, tx pgx.Tx, u runner.User, in CreateOrderInput) ([]resolvedParticipant, error) {
	fe := newFieldErrors()
	out := make([]resolvedParticipant, 0, len(in.Participants))
	seen := map[string]bool{}
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		var prof runner.ProfileData
		if p.ProfileID != nil {
			loaded, err := s.runners.LoadProfileForOrder(ctx, tx, u, *p.ProfileID, prefix)
			if err != nil {
				if mergeErr := fe.merge(err); mergeErr != nil {
					return nil, mergeErr
				}
				continue
			}
			loaded = runner.NormalizeProfile(loaded)
			if err := fe.merge(runner.ValidateProfile(loaded, prefix)); err != nil {
				return nil, err
			}
			prof = loaded
		} else {
			prof = *p.Profile
		}
		hash := s.runners.PII().Hash(prof.IDNo)
		if seen[string(hash)] {
			fe.add(prefix+"idNo", "field.duplicate_id_no", nil)
		}
		seen[string(hash)] = true
		out = append(out, resolvedParticipant{input: p, profile: prof, idHash: hash})
	}
	if err := fe.result(); err != nil {
		return nil, err
	}
	return out, nil
}

// checkAlreadyRegistered 先按哈希字节序对每个证件号加 advisory 锁，再查同赛事 PENDING/CONFIRMED 报名。
func checkAlreadyRegistered(ctx context.Context, q *store.Queries, eventID int64, parts []resolvedParticipant) error {
	hashes := make([][]byte, 0, len(parts))
	for _, p := range parts {
		hashes = append(hashes, p.idHash)
	}
	slices.SortFunc(hashes, bytes.Compare)
	for _, h := range hashes {
		if err := q.LockIDNoHash(ctx, store.LockIDNoHashParams{EventID: eventID, IDNoHash: h}); err != nil {
			return fmt.Errorf("lock id number hash: %w", err)
		}
	}
	taken, err := q.ListRegisteredIDNoHashes(ctx, store.ListRegisteredIDNoHashesParams{EventID: eventID, Hashes: hashes})
	if err != nil {
		return fmt.Errorf("list registered id numbers: %w", err)
	}
	if len(taken) == 0 {
		return nil
	}
	registered := make(map[string]bool, len(taken))
	for _, h := range taken {
		registered[string(h)] = true
	}
	aerr := apperr.New(http.StatusConflict, apperr.CodeAlreadyRegistered)
	for i, p := range parts {
		if registered[string(p.idHash)] {
			aerr = aerr.WithField(fmt.Sprintf("participants[%d].idNo", i), "field.already_registered", nil)
		}
	}
	return aerr
}

// insertRegistration 在保存点里插入报名，reg_no 或 ticket_code 冲突时重新生成（各最多 3 次）。
func insertRegistration(ctx context.Context, tx pgx.Tx, params store.InsertRegistrationParams) error {
	err := idgen.Retry("registrations_reg_no_key", func() error {
		return idgen.Retry("registrations_ticket_code_key", func() error {
			return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
				params.RegNo = idgen.Code(idgen.PrefixRegistration)
				params.TicketCode = idgen.TicketCode()
				_, err := store.New(sp).InsertRegistration(ctx, params)
				return err
			})
		})
	})
	if err != nil {
		return fmt.Errorf("insert registration: %w", err)
	}
	return nil
}

// ConfirmPaid 把订单改为 PAID 并消耗预留。只在调用方事务内使用，依次：
//  1. 订单条件更新（reservation_state RESERVED → CONSUMED；状态须为 PROOF_SUBMITTED，或应付为 0 的 PENDING_PAYMENT），
//     影响行数不是 1 时返回 ORDER_STATE_CONFLICT，此时不碰任何计数；
//  2. pricing.Consume（它本身不幂等，由第 1 步保证每单只调用一次）；
//  3. 报名改为 CONFIRMED。
func (s *Service) ConfirmPaid(ctx context.Context, tx pgx.Tx, orderID int64, paidAt time.Time) error {
	q := store.New(tx)
	n, err := q.MarkOrderPaid(ctx, store.MarkOrderPaidParams{PaidAt: paidAt, ID: orderID})
	if err != nil {
		return fmt.Errorf("mark order %d paid: %w", orderID, err)
	}
	if n != 1 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	if err := s.prices.Consume(ctx, tx, orderID); err != nil {
		return err
	}
	if _, err := q.ConfirmOrderRegistrations(ctx, store.ConfirmOrderRegistrationsParams{
		ConfirmedAt: s.now().UTC(),
		OrderID:     orderID,
	}); err != nil {
		return fmt.Errorf("confirm registrations of order %d: %w", orderID, err)
	}
	return nil
}

// PreviewQuote 返回算价预览：赛事须为已发布的 RACE，不占名额、不选识别分。
func (s *Service) PreviewQuote(ctx context.Context, _ runner.User, slug string, in QuotePreviewInput) (pricing.Quote, error) {
	fe := newFieldErrors()
	if n := len(in.Participants); n < MinParticipants || n > MaxParticipants {
		fe.add("participants", "field.invalid", nil)
	}
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		if p.CategoryID <= 0 {
			fe.add(prefix+"categoryId", "field.required", nil)
		}
		if !nationalityPattern.MatchString(strings.ToUpper(strings.TrimSpace(p.Nationality))) {
			fe.add(prefix+"nationality", "field.invalid", nil)
		}
		if p.BirthDate.IsZero() {
			fe.add(prefix+"birthDate", "field.required", nil)
		}
	}
	if err := fe.result(); err != nil {
		return pricing.Quote{}, err
	}

	now := s.now().UTC()
	var out pricing.Quote
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		ev, err := store.New(tx).GetEventForQuote(ctx, strings.TrimSpace(slug))
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (ev.Status != "PUBLISHED" || ev.EventType != "RACE")) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("load event %q: %w", slug, err)
		}
		q, err := s.prices.Quote(ctx, tx, pricing.QuoteInput{
			EventID:      ev.ID,
			RaceDate:     ev.RaceDate,
			CouponCode:   in.CouponCode,
			Participants: in.Participants,
			Now:          now,
		})
		out = q
		return err
	})
	if err != nil {
		return pricing.Quote{}, err
	}
	return out, nil
}
