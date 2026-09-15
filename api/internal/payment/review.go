package payment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/money"
	"werun/api/internal/platform/settings"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
)

func init() {
	apperr.RegisterConstraint(constraintReceiptTxnRef, func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeProofTxnRefUsed)
	})
}

// payment_proofs.status 的取值。
const (
	proofStatusSubmitted = "SUBMITTED"
	proofStatusApproved  = "APPROVED"
	proofStatusRejected  = "REJECTED"
)

const (
	// payment_receipts 的 UNIQUE (payment_account_id, txn_ref) 未命名，这是 PostgreSQL 生成的名字（TestReceiptTxnRefConstraintName 核对）。
	constraintReceiptTxnRef = "payment_receipts_payment_account_id_txn_ref_key"
	constraintExceptionNo   = "payment_exceptions_exception_no_key"

	matchStatusApplied   = "APPLIED"
	matchStatusException = "EXCEPTION"
	rejectCodeOther      = "OTHER"

	maxReviewTextLen = 500
	// receivedAtFutureTolerance 是到账时间允许晚于服务器时间的最大偏差（财务电脑时钟误差）。
	receivedAtFutureTolerance = 5 * time.Minute
)

var (
	rejectCodes = map[string]bool{
		"NOT_RECEIVED": true, "AMOUNT_MISMATCH": true, "DUPLICATE_TXN": true, "UNREADABLE": true,
		"WRONG_ACCOUNT": true, "FRAUD": true, rejectCodeOther: true,
	}
	queueStatuses = map[string]bool{proofStatusSubmitted: true, proofStatusApproved: true, proofStatusRejected: true}
)

// ProofQueueItem 是审核队列中的一行。
type ProofQueueItem struct {
	Proof
	AmountCents  int64
	EventName    i18n.Text
	WaitingSince time.Time
	OverSLA      bool
}

// ProofDetail 是凭证详情：凭证本身加所属订单的后台详情。
type ProofDetail struct {
	Proof
	Order registration.AdminOrderDetail
}

// ApproveInput 是审核通过的输入。
type ApproveInput struct {
	ReceivedAmountCents int64
	ReceivedAt          time.Time
	Note                *string
}

// RejectInput 是驳回的输入。
type RejectInput struct {
	Code   string
	Reason *string
}

// ListProofs 列出某个状态的凭证（空串为 SUBMITTED），按提交时间升序；待审且等待超过 payment.review_sla_hours 的标记 OverSLA。
func (s *Service) ListProofs(ctx context.Context, status string) ([]ProofQueueItem, error) {
	status = strings.ToUpper(strings.TrimSpace(status))
	if status == "" {
		status = proofStatusSubmitted
	}
	if !queueStatuses[status] {
		return nil, validationError().WithField("status", "field.invalid", nil)
	}
	cfg, err := settings.LoadPayment(ctx, s.pool)
	if err != nil {
		return nil, fmt.Errorf("load payment settings: %w", err)
	}
	rows, err := store.New(s.pool).ListProofQueue(ctx, status)
	if err != nil {
		return nil, fmt.Errorf("list proof queue: %w", err)
	}
	now := s.now()
	items := make([]ProofQueueItem, 0, len(rows))
	for _, r := range rows {
		var name i18n.Text
		if err := json.Unmarshal(r.EventName, &name); err != nil {
			return nil, fmt.Errorf("decode event name of proof %d: %w", r.PaymentProof.ID, err)
		}
		p := proofFromRow(r.PaymentProof, r.OrderNo)
		items = append(items, ProofQueueItem{
			Proof:        p,
			AmountCents:  r.OrderAmountCents,
			EventName:    name,
			WaitingSince: p.CreatedAt,
			OverSLA:      p.Status == proofStatusSubmitted && now.Sub(p.CreatedAt) > cfg.ReviewSLA,
		})
	}
	return items, nil
}

// GetProof 返回凭证与所属订单详情；不存在（或不属于报名订单）返回 NOT_FOUND。
func (s *Service) GetProof(ctx context.Context, id int64) (ProofDetail, error) {
	row, err := store.New(s.pool).GetPaymentProofForReview(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProofDetail{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return ProofDetail{}, fmt.Errorf("get proof %d: %w", id, err)
	}
	p := proofFromRow(row.PaymentProof, row.OrderNo)
	order, err := s.orders.AdminGetOrder(ctx, p.OrderID)
	if err != nil {
		return ProofDetail{}, err
	}
	return ProofDetail{Proof: p, Order: order}, nil
}

// ApproveProof 按 spec 6.3 通过凭证：凭证改为 APPROVED，写到账记录（多付时登记 OVERPAID 异常），
// 经 registration.ConfirmPaid 确认订单并核销名额，写审计。任一步失败整个事务回滚。
func (s *Service) ApproveProof(ctx context.Context, actor iam.Staff, id int64, in ApproveInput, meta httpx.Meta) (ProofDetail, error) {
	note := trimOptional(in.Note)
	if err := s.validateApprove(in, note); err != nil {
		return ProofDetail{}, err
	}
	receivedAt := in.ReceivedAt.UTC()

	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		proof, order, err := s.lockForReview(ctx, tx, q, id)
		if err != nil {
			return err
		}
		if in.ReceivedAmountCents < order.AmountCents {
			params := map[string]any{"amountDue": money.Cents(order.AmountCents).String()}
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeReceivedAmountTooLow).
				WithParams(params).
				WithField("receivedAmountCents", apperr.CodeReceivedAmountTooLow, params)
		}

		n, err := q.MarkPaymentProofApproved(ctx, store.MarkPaymentProofApprovedParams{
			ID: proof.ID, ReviewedBy: actor.ID, ReviewedAt: s.now().UTC(),
		})
		if err != nil {
			return fmt.Errorf("approve proof %d: %w", proof.ID, err)
		}
		if n != 1 {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}

		overpaid := in.ReceivedAmountCents - order.AmountCents
		matchStatus := matchStatusApplied
		if overpaid > 0 {
			matchStatus = matchStatusException
		}
		receiptID, err := q.InsertPaymentReceipt(ctx, store.InsertPaymentReceiptParams{
			PaymentAccountID: proof.PaymentAccountID,
			TxnRef:           proof.BankTxnRef,
			AmountCents:      in.ReceivedAmountCents,
			ReceivedAt:       receivedAt,
			ProofID:          proof.ID,
			RegOrderID:       order.ID,
			MatchStatus:      matchStatus,
			RecordedBy:       actor.ID,
		})
		if err != nil {
			return apperr.FromPG(fmt.Errorf("insert receipt for proof %d: %w", proof.ID, err))
		}

		after := map[string]any{
			"proofStatus":         proofStatusApproved,
			"orderStatus":         registration.StatusPaid,
			"receivedAmountCents": in.ReceivedAmountCents,
			"receivedAt":          receivedAt,
			"receiptId":           receiptID,
			"matchStatus":         matchStatus,
		}
		if note != nil {
			after["note"] = *note
		}
		if overpaid > 0 {
			var exceptionNo string
			err := idgen.Retry(constraintExceptionNo, func() error {
				return inSavepoint(ctx, tx, func(sq *store.Queries) error {
					exceptionNo = idgen.Code(idgen.PrefixException)
					_, insertErr := sq.InsertPaymentException(ctx, store.InsertPaymentExceptionParams{
						ExceptionNo: exceptionNo,
						RegOrderID:  order.ID,
						ReceiptID:   receiptID,
						AmountCents: overpaid,
						Note:        note,
					})
					return insertErr
				})
			})
			if err != nil {
				return apperr.FromPG(err)
			}
			after["overpaidCents"] = overpaid
			after["exceptionNo"] = exceptionNo
		}

		// ConfirmPaid 先做订单条件更新（PROOF_SUBMITTED 且 RESERVED → PAID/CONSUMED，影响 1 行才继续），再核销名额。
		if err := s.orders.ConfirmPaid(ctx, tx, order.ID, receivedAt); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, reviewAudit(actor, "payment_proof.approve", proof, order,
			fmt.Sprintf("通过凭证 %s，订单 %s 到账 %s", proof.ProofNo, order.OrderNo, money.Cents(in.ReceivedAmountCents)),
			after, meta)); err != nil {
			return err
		}
		if err := s.enqueueProofApproved(ctx, tx, order.ID, proof.ID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return ProofDetail{}, err
	}
	return s.GetProof(ctx, id)
}

// RejectProof 按 spec 6.4 驳回凭证：凭证改为 REJECTED，订单改为被驳回并开放重传期，写审计。
func (s *Service) RejectProof(ctx context.Context, actor iam.Staff, id int64, in RejectInput, meta httpx.Meta) (ProofDetail, error) {
	// 规范化结果写回 in：事务内以及之后使用 in 的代码（Task 20 的推送）拿到的都是规范化后的原因码与说明。
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	in.Reason = trimOptional(in.Reason)
	if err := validateReject(in.Code, in.Reason); err != nil {
		return ProofDetail{}, err
	}

	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		proof, order, err := s.lockForReview(ctx, tx, q, id)
		if err != nil {
			return err
		}
		cfg, err := settings.LoadPayment(ctx, tx)
		if err != nil {
			return fmt.Errorf("load payment settings: %w", err)
		}
		now := s.now().UTC()
		n, err := q.MarkPaymentProofRejected(ctx, store.MarkPaymentProofRejectedParams{
			ID: proof.ID, ReviewedBy: actor.ID, ReviewedAt: now, RejectCode: in.Code, RejectReason: in.Reason,
		})
		if err != nil {
			return fmt.Errorf("reject proof %d: %w", proof.ID, err)
		}
		if n != 1 {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		deadline := now.Add(cfg.ReuploadWindow)
		if err := s.orders.MarkProofRejected(ctx, tx, order.ID, deadline); err != nil {
			return err
		}

		after := map[string]any{
			"proofStatus": proofStatusRejected,
			"orderStatus": registration.StatusProofRejected,
			"rejectCode":  in.Code,
			"deadlineAt":  deadline,
		}
		if in.Reason != nil {
			after["rejectReason"] = *in.Reason
		}
		if err := audit.Record(ctx, tx, reviewAudit(actor, "payment_proof.reject", proof, order,
			fmt.Sprintf("驳回凭证 %s（%s），订单 %s 可重传至 %s", proof.ProofNo, in.Code, order.OrderNo, deadline.Format(time.RFC3339)),
			after, meta)); err != nil {
			return err
		}
		if err := s.enqueueProofRejected(ctx, tx, order.ID, proof.ID, in); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return ProofDetail{}, err
	}
	return s.GetProof(ctx, id)
}

// OpenProofFile 只打开被 payment_proofs.file_id 引用、用途为 PAYMENT_PROOF 的私有文件；其他文件（含收款二维码）一律 NOT_FOUND。
func (s *Service) OpenProofFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error) {
	ok, err := store.New(s.pool).IsProofFile(ctx, id)
	if err != nil {
		return storage.File{}, nil, fmt.Errorf("check proof file %d: %w", id, err)
	}
	if !ok {
		return storage.File{}, nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return s.OpenPrivateFile(ctx, id)
}

// lockForReview 在 READ COMMITTED 事务里先锁凭证行、再锁订单行（之后 ConfirmPaid 才改计数行），
// 校验凭证为 SUBMITTED 且订单为 PROOF_SUBMITTED，否则 ORDER_STATE_CONFLICT。不取收款账户的咨询锁。
func (s *Service) lockForReview(ctx context.Context, tx pgx.Tx, q *store.Queries, id int64) (store.PaymentProof, registration.Order, error) {
	proof, err := q.LockPaymentProof(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.PaymentProof{}, registration.Order{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return store.PaymentProof{}, registration.Order{}, fmt.Errorf("lock proof %d: %w", id, err)
	}
	if proof.RegOrderID == nil {
		return store.PaymentProof{}, registration.Order{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	order, err := s.orders.LockOrderByID(ctx, tx, *proof.RegOrderID)
	if err != nil {
		return store.PaymentProof{}, registration.Order{}, err
	}
	if proof.Status != proofStatusSubmitted || order.Status != registration.StatusProofSubmitted {
		return store.PaymentProof{}, registration.Order{}, apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return proof, order, nil
}

func (s *Service) validateApprove(in ApproveInput, note *string) error {
	verr := validationError()
	if in.ReceivedAmountCents <= 0 {
		verr = verr.WithField("receivedAmountCents", "field.must_be_positive", nil)
	}
	switch {
	case in.ReceivedAt.IsZero():
		verr = verr.WithField("receivedAt", "field.required", nil)
	case in.ReceivedAt.After(s.now().Add(receivedAtFutureTolerance)):
		verr = verr.WithField("receivedAt", "field.invalid", nil)
	}
	if note != nil && utf8.RuneCountInString(*note) > maxReviewTextLen {
		verr = verr.WithField("note", "field.too_long", map[string]any{"max": maxReviewTextLen})
	}
	if len(verr.Fields) > 0 {
		return verr
	}
	return nil
}

func validateReject(code string, reason *string) error {
	verr := validationError()
	if !rejectCodes[code] {
		verr = verr.WithField("rejectCode", "field.invalid", nil)
	}
	switch {
	case code == rejectCodeOther && reason == nil:
		verr = verr.WithField("rejectReason", "field.required", nil)
	case reason != nil && utf8.RuneCountInString(*reason) > maxReviewTextLen:
		verr = verr.WithField("rejectReason", "field.too_long", map[string]any{"max": maxReviewTextLen})
	}
	if len(verr.Fields) > 0 {
		return verr
	}
	return nil
}

func reviewAudit(actor iam.Staff, action string, proof store.PaymentProof, order registration.Order, summary string, after map[string]any, meta httpx.Meta) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	eventID := order.EventID
	return audit.Entry{
		ActorType:   "STAFF",
		ActorID:     &actorID,
		ActorRole:   &role,
		Action:      action,
		EntityType:  "payment_proof",
		EntityID:    proof.ID,
		EventID:     &eventID,
		IsFinancial: true,
		Summary:     summary,
		Before: map[string]any{
			"proofNo":             proof.ProofNo,
			"proofStatus":         proof.Status,
			"orderNo":             order.OrderNo,
			"orderStatus":         order.Status,
			"bankTxnRef":          proof.BankTxnRef,
			"declaredAmountCents": proof.DeclaredAmountCents,
			"amountCents":         order.AmountCents,
		},
		After: after,
		Meta:  meta,
	}
}
