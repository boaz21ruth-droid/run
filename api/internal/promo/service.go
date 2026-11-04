// Package promo 是推荐渠道与免费入场（v8 设计稿 02、10）：
// 推荐链接（/r/<slug>）计点击、可带一个只限本赛事的优惠码，订单按链接归因；
// KOL / 跑团团长 / 赞助商 / 媒体申请免费入场，运营批准后发一个本人专用、限 1 人的免费报名码。
package promo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/pricing"
	"werun/api/internal/promo/store"
	"werun/api/internal/runner"
)

// 推荐链接与申请的取值。
const (
	StatusActive   = "ACTIVE"
	StatusDisabled = "DISABLED"

	CompPending  = "PENDING"
	CompApproved = "APPROVED"
	CompRejected = "REJECTED"

	// compCodePrefix 是免费报名码前缀，后接 8 位 Crockford Base32。
	compCodePrefix = "COMP-"
)

var (
	slugPattern   = regexp.MustCompile(`^[a-z0-9-]{2,32}$`)
	referralKinds = map[string]bool{"CLUB": true, "KOL": true, "SPONSOR": true, "CHANNEL": true, "OTHER": true}
	compKinds     = map[string]bool{"KOL": true, "CLUB": true, "SPONSOR": true, "MEDIA": true}
)

func init() {
	apperr.RegisterConstraint("referral_links_slug_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeReferralSlugTaken).
			WithField("slug", apperr.CodeReferralSlugTaken, nil)
	})
	apperr.RegisterConstraint("comp_requests_active_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeCompRequestExists)
	})
}

// Service 是推荐渠道与免费入场的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建服务。
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service {
	return &Service{pool: pool, now: now}
}

// Offer 是推荐码的优惠规则。
type Offer struct {
	DiscountType  string
	DiscountValue int64
}

// Visit 是打开推荐链接的结果。CouponCode 只在优惠码启用且在有效期内时返回。
type Visit struct {
	EventSlug  string
	Label      string
	Kind       string
	CouponCode *string
	Offer      *Offer
}

// VisitReferral 计一次点击。链接不存在、已停用或赛事未公开都返回 NOT_FOUND。
func (s *Service) VisitReferral(ctx context.Context, slug string) (Visit, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	if !slugPattern.MatchString(slug) {
		return Visit{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	var out Visit
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.VisitReferral(ctx, slug)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("visit referral %q: %w", slug, err)
		}
		out = Visit{EventSlug: row.EventSlug, Label: row.Label, Kind: row.Kind}
		if row.CouponID == nil {
			return nil
		}
		c, err := q.GetReferralCoupon(ctx, *row.CouponID)
		if err != nil {
			return fmt.Errorf("load referral coupon %d: %w", *row.CouponID, err)
		}
		now := s.now()
		if c.Status == pricing.CouponActive &&
			(c.ValidFrom == nil || !c.ValidFrom.After(now)) &&
			(c.ValidUntil == nil || c.ValidUntil.After(now)) &&
			c.UsedCount+c.ReservedCount < c.Quota {
			code := c.Code
			out.CouponCode = &code
			out.Offer = &Offer{DiscountType: c.DiscountType, DiscountValue: c.DiscountValue}
		}
		return nil
	})
	return out, err
}

// ReferralCoupon 是推荐链接带的优惠码。
type ReferralCoupon struct {
	ID            int64
	Code          string
	Offer         Offer
	Quota         int32
	UsedCount     int32
	ReservedCount int32
	Status        string
}

// ReferralLink 是推荐链接及其归因统计。
type ReferralLink struct {
	ID, EventID int64
	Slug        string
	Label       string
	Kind        string
	Status      string
	ClickCount  int64
	Orders      int32 // 归因到这条链接的订单（含未付款、已取消）
	PaidOrders  int32
	Coupon      *ReferralCoupon
	CreatedAt   time.Time
}

// ReferralStats 是一个赛事的渠道归因。
type ReferralStats struct {
	Links            []ReferralLink
	DirectOrders     int32
	DirectPaidOrders int32
}

func linkFromRow(r store.ListReferralLinksRow) ReferralLink {
	l := ReferralLink{
		ID: r.ID, EventID: r.EventID, Slug: r.Slug, Label: r.Label, Kind: r.Kind, Status: r.Status,
		ClickCount: r.ClickCount, Orders: r.Orders, PaidOrders: r.PaidOrders, CreatedAt: r.CreatedAt,
	}
	if r.CouponID != nil && r.CouponCode != nil {
		l.Coupon = &ReferralCoupon{
			ID:            *r.CouponID,
			Code:          *r.CouponCode,
			Offer:         Offer{DiscountType: deref(r.CouponDiscountType), DiscountValue: deref(r.CouponDiscountValue)},
			Quota:         deref(r.CouponQuota),
			UsedCount:     deref(r.CouponUsedCount),
			ReservedCount: deref(r.CouponReservedCount),
			Status:        deref(r.CouponStatus),
		}
	}
	return l
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

func (s *Service) requireEvent(ctx context.Context, q *store.Queries, eventID int64) error {
	ok, err := q.PromoEventExists(ctx, eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", eventID, err)
	}
	if !ok {
		return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	return nil
}

// ListReferralLinks 返回赛事的推荐链接（按创建顺序）与「直接 / 其他」订单数。
func (s *Service) ListReferralLinks(ctx context.Context, eventID int64) (ReferralStats, error) {
	q := store.New(s.pool)
	if err := s.requireEvent(ctx, q, eventID); err != nil {
		return ReferralStats{}, err
	}
	rows, err := q.ListReferralLinks(ctx, eventID)
	if err != nil {
		return ReferralStats{}, fmt.Errorf("list referral links of event %d: %w", eventID, err)
	}
	direct, err := q.DirectOrderStats(ctx, eventID)
	if err != nil {
		return ReferralStats{}, fmt.Errorf("direct order stats of event %d: %w", eventID, err)
	}
	out := ReferralStats{Links: make([]ReferralLink, 0, len(rows)), DirectOrders: direct.Orders, DirectPaidOrders: direct.PaidOrders}
	for _, r := range rows {
		out.Links = append(out.Links, linkFromRow(r))
	}
	return out, nil
}

// OfferInput 是新建推荐链接时一并新建的优惠码。
type OfferInput struct {
	Code  string
	Offer Offer
	Quota int32
}

// ReferralLinkInput 是新建推荐链接的输入。
type ReferralLinkInput struct {
	Slug  string
	Label string
	Kind  string
	Offer *OfferInput
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

// CreateReferralLink 新建推荐链接；带优惠码时同一事务里新建一个只限本赛事的优惠码（规则与后台优惠码相同）。
func (s *Service) CreateReferralLink(ctx context.Context, actor iam.Staff, eventID int64, in ReferralLinkInput) (ReferralLink, error) {
	in.Slug = strings.ToLower(strings.TrimSpace(in.Slug))
	in.Label = strings.TrimSpace(in.Label)
	verr := validationError()
	failed := false
	if !slugPattern.MatchString(in.Slug) {
		verr = verr.WithField("slug", "field.slug_format", nil)
		failed = true
	}
	if n := utf8.RuneCountInString(in.Label); n == 0 || n > 60 {
		verr = verr.WithField("label", "field.required", nil)
		failed = true
	}
	if !referralKinds[in.Kind] {
		verr = verr.WithField("kind", "field.invalid", nil)
		failed = true
	}
	var coupon pricing.CouponInput
	if in.Offer != nil {
		coupon = pricing.CouponInput{
			Code:          pricing.NormalizeCouponCode(in.Offer.Code),
			EventID:       &eventID,
			DiscountType:  in.Offer.Offer.DiscountType,
			DiscountValue: in.Offer.Offer.DiscountValue,
			Quota:         in.Offer.Quota,
			Status:        pricing.CouponActive,
		}
		var cerr *apperr.Error
		if err := pricing.ValidateCoupon(coupon); errors.As(err, &cerr) {
			for field, f := range cerr.Fields {
				verr = verr.WithField("offer."+field, f.Key, f.Params)
			}
			failed = true
		} else if err != nil {
			return ReferralLink{}, err
		}
	}
	if failed {
		return ReferralLink{}, verr
	}

	var out ReferralLink
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := s.requireEvent(ctx, q, eventID); err != nil {
			return err
		}
		actorID := actor.ID
		var couponID *int64
		if in.Offer != nil {
			id, err := q.InsertPromoCoupon(ctx, store.InsertPromoCouponParams{
				Code:          coupon.Code,
				EventID:       &eventID,
				DiscountType:  coupon.DiscountType,
				DiscountValue: coupon.DiscountValue,
				Quota:         coupon.Quota,
				CreatedBy:     &actorID,
			})
			if err != nil {
				return prefixCouponField(apperr.FromPG(err))
			}
			couponID = &id
		}
		id, err := q.InsertReferralLink(ctx, store.InsertReferralLinkParams{
			EventID: eventID, Slug: in.Slug, Label: in.Label, Kind: in.Kind, CouponID: couponID, CreatedBy: &actorID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		row, err := q.GetReferralLink(ctx, id)
		if err != nil {
			return fmt.Errorf("load referral link %d: %w", id, err)
		}
		out = linkFromRow(store.ListReferralLinksRow(row))
		after := map[string]any{"slug": in.Slug, "label": in.Label, "kind": in.Kind, "couponId": couponID}
		if in.Offer != nil {
			after["couponCode"] = coupon.Code
			after["discountType"] = coupon.DiscountType
			after["discountValue"] = coupon.DiscountValue
			after["quota"] = coupon.Quota
		}
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "referral_link.create", "referral_link", id, &eventID,
			fmt.Sprintf("新建推荐链接 %s（%s）", in.Slug, in.Label), nil, after))
	})
	if err != nil {
		return ReferralLink{}, err
	}
	return out, nil
}

// prefixCouponField 把优惠码重复的字段错误挂到 offer.code 上。
func prefixCouponField(err error) error {
	var e *apperr.Error
	if errors.As(err, &e) && e.Code == apperr.CodeCouponCodeTaken {
		return apperr.New(e.Status, e.Code).WithField("offer.code", apperr.CodeCouponCodeTaken, nil)
	}
	return err
}

// UpdateReferralLink 改名称与启用状态；停用 / 启用同时作用于它的优惠码，停用后链接不再计点击、不再归因。
func (s *Service) UpdateReferralLink(ctx context.Context, actor iam.Staff, id int64, label, status string) (ReferralLink, error) {
	label = strings.TrimSpace(label)
	verr := validationError()
	failed := false
	if n := utf8.RuneCountInString(label); n == 0 || n > 60 {
		verr = verr.WithField("label", "field.required", nil)
		failed = true
	}
	if status != StatusActive && status != StatusDisabled {
		verr = verr.WithField("status", "field.invalid", nil)
		failed = true
	}
	if failed {
		return ReferralLink{}, verr
	}
	var out ReferralLink
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		before, err := q.LockReferralLink(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock referral link %d: %w", id, err)
		}
		if err := q.UpdateReferralLink(ctx, store.UpdateReferralLinkParams{Label: label, Status: status, ID: id}); err != nil {
			return fmt.Errorf("update referral link %d: %w", id, err)
		}
		if before.CouponID != nil && before.Status != status {
			if err := q.SetCouponStatus(ctx, store.SetCouponStatusParams{Status: status, ID: *before.CouponID}); err != nil {
				return fmt.Errorf("set coupon %d status: %w", *before.CouponID, err)
			}
		}
		row, err := q.GetReferralLink(ctx, id)
		if err != nil {
			return fmt.Errorf("load referral link %d: %w", id, err)
		}
		out = linkFromRow(store.ListReferralLinksRow(row))
		eventID := before.EventID
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "referral_link.update", "referral_link", id, &eventID,
			fmt.Sprintf("修改推荐链接 %s", out.Slug),
			map[string]any{"label": before.Label, "status": before.Status},
			map[string]any{"label": label, "status": status}))
	})
	if err != nil {
		return ReferralLink{}, err
	}
	return out, nil
}

// CompRequest 是免费入场申请。
type CompRequest struct {
	ID               int64
	EventID          int64
	UserID           int64
	ApplicantName    string
	Kind             string
	ProfileURL       *string
	Audience         *string
	Note             *string
	Status           string
	CouponCode       *string
	CouponUsed       bool
	ReviewNote       *string
	ReviewedAt       *time.Time
	TelegramUsername *string
	CreatedAt        time.Time
}

func compFromRow(r store.ListCompRequestsRow) CompRequest {
	return CompRequest{
		ID: r.ID, EventID: r.EventID, UserID: r.UserID, ApplicantName: r.ApplicantName, Kind: r.Kind,
		ProfileURL: r.ProfileUrl, Audience: r.Audience, Note: r.Note, Status: r.Status,
		CouponCode: r.CouponCode, CouponUsed: r.CouponUsed, ReviewNote: r.ReviewNote, ReviewedAt: r.ReviewedAt,
		TelegramUsername: r.TelegramUsername, CreatedAt: r.CreatedAt,
	}
}

// CompStatus 是跑者在某赛事的免费入场申请状态。
type CompStatus struct {
	Open    bool
	Request *CompRequest
}

// loadCompEvent 取已发布、公开的 RACE 赛事；其他情况 EVENT_NOT_FOUND。
func loadCompEvent(ctx context.Context, q *store.Queries, slug string) (store.GetCompEventRow, error) {
	ev, err := q.GetCompEvent(ctx, strings.TrimSpace(slug))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (ev.Status != "PUBLISHED" || !ev.PublicVisible || ev.EventType != "RACE")) {
		return store.GetCompEventRow{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return store.GetCompEventRow{}, fmt.Errorf("load event %q: %w", slug, err)
	}
	return ev, nil
}

// MyCompRequest 返回本人在该赛事最近一条申请（没有为 nil）。
func (s *Service) MyCompRequest(ctx context.Context, u runner.User, slug string) (CompStatus, error) {
	q := store.New(s.pool)
	ev, err := loadCompEvent(ctx, q, slug)
	if err != nil {
		return CompStatus{}, err
	}
	out := CompStatus{Open: ev.CompQuota != nil}
	row, err := q.GetMyCompRequest(ctx, store.GetMyCompRequestParams{EventID: ev.ID, UserID: u.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return CompStatus{}, fmt.Errorf("load comp request: %w", err)
	}
	c := CompRequest{
		ID: row.ID, EventID: row.EventID, UserID: row.UserID, ApplicantName: row.ApplicantName, Kind: row.Kind,
		ProfileURL: row.ProfileUrl, Audience: row.Audience, Note: row.Note, Status: row.Status,
		CouponCode: row.CouponCode, ReviewNote: row.ReviewNote, ReviewedAt: row.ReviewedAt, CreatedAt: row.CreatedAt,
	}
	out.Request = &c
	return out, nil
}

// CompRequestInput 是跑者提交的申请。
type CompRequestInput struct {
	ApplicantName string
	Kind          string
	ProfileURL    string
	Audience      string
	Note          string
}

func optText(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func validateCompInput(in CompRequestInput) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}
	switch n := utf8.RuneCountInString(strings.TrimSpace(in.ApplicantName)); {
	case n == 0:
		add("applicantName", "field.required", nil)
	case n > 80:
		add("applicantName", "field.too_long", map[string]any{"max": 80})
	}
	if !compKinds[in.Kind] {
		add("kind", "field.invalid", nil)
	}
	if link := strings.TrimSpace(in.ProfileURL); link != "" {
		u, err := url.Parse(link)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || len(link) > 300 {
			add("profileUrl", "field.url_format", nil)
		}
	}
	if utf8.RuneCountInString(strings.TrimSpace(in.Audience)) > 80 {
		add("audience", "field.too_long", map[string]any{"max": 80})
	}
	if utf8.RuneCountInString(strings.TrimSpace(in.Note)) > 500 {
		add("note", "field.too_long", map[string]any{"max": 500})
	}
	if failed {
		return verr
	}
	return nil
}

// CreateCompRequest 提交申请。赛事不开放申请返回 COMP_CLOSED；已有进行中或已批准的申请返回 COMP_REQUEST_EXISTS。
func (s *Service) CreateCompRequest(ctx context.Context, u runner.User, slug string, in CompRequestInput, meta httpx.Meta) (CompRequest, error) {
	if err := validateCompInput(in); err != nil {
		return CompRequest{}, err
	}
	var out CompRequest
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		ev, err := loadCompEvent(ctx, q, slug)
		if err != nil {
			return err
		}
		if ev.CompQuota == nil {
			return apperr.New(http.StatusConflict, apperr.CodeCompClosed)
		}
		id, err := q.InsertCompRequest(ctx, store.InsertCompRequestParams{
			EventID:       ev.ID,
			UserID:        u.ID,
			ApplicantName: strings.TrimSpace(in.ApplicantName),
			Kind:          in.Kind,
			ProfileUrl:    optText(in.ProfileURL),
			Audience:      optText(in.Audience),
			Note:          optText(in.Note),
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		row, err := q.GetCompRequest(ctx, id)
		if err != nil {
			return fmt.Errorf("load comp request %d: %w", id, err)
		}
		out = compFromRow(store.ListCompRequestsRow(row))
		userID := u.ID
		eventID := ev.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "USER",
			ActorID:    &userID,
			Action:     "comp_request.create",
			EntityType: "comp_request",
			EntityID:   id,
			EventID:    &eventID,
			Summary:    fmt.Sprintf("申请免费入场（%s）", in.Kind),
			After:      map[string]any{"kind": in.Kind, "applicantName": out.ApplicantName, "profileUrl": out.ProfileURL},
			Meta:       meta,
		})
	})
	if err != nil {
		return CompRequest{}, err
	}
	return out, nil
}

// CompList 是后台看到的申请与名额。
type CompList struct {
	Quota    *int32
	Approved int32
	Pending  int32
	Items    []CompRequest
}

// ListCompRequests 返回赛事的申请（待审批在前）与名额。
func (s *Service) ListCompRequests(ctx context.Context, eventID int64) (CompList, error) {
	return s.compList(ctx, store.New(s.pool), eventID)
}

func (s *Service) compList(ctx context.Context, q *store.Queries, eventID int64) (CompList, error) {
	if err := s.requireEvent(ctx, q, eventID); err != nil {
		return CompList{}, err
	}
	quota, err := q.GetCompQuota(ctx, eventID)
	if err != nil {
		return CompList{}, fmt.Errorf("load comp quota of event %d: %w", eventID, err)
	}
	counts, err := q.CompCounts(ctx, eventID)
	if err != nil {
		return CompList{}, fmt.Errorf("count comp requests of event %d: %w", eventID, err)
	}
	rows, err := q.ListCompRequests(ctx, eventID)
	if err != nil {
		return CompList{}, fmt.Errorf("list comp requests of event %d: %w", eventID, err)
	}
	out := CompList{Quota: quota, Approved: counts.Approved, Pending: counts.Pending, Items: make([]CompRequest, 0, len(rows))}
	for _, r := range rows {
		out.Items = append(out.Items, compFromRow(r))
	}
	return out, nil
}

// UpdateCompQuota 设置名额；nil 关闭申请（已批准的码仍然有效）。名额不能低于已批准人数。
func (s *Service) UpdateCompQuota(ctx context.Context, actor iam.Staff, eventID int64, quota *int32) (CompList, error) {
	if quota != nil && *quota < 0 {
		return CompList{}, validationError().WithField("quota", "field.invalid", nil)
	}
	var out CompList
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		before, err := q.LockCompEvent(ctx, eventID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %d: %w", eventID, err)
		}
		counts, err := q.CompCounts(ctx, eventID)
		if err != nil {
			return fmt.Errorf("count comp requests of event %d: %w", eventID, err)
		}
		if quota != nil && *quota < counts.Approved {
			return validationError().WithField("quota", "field.quota_below_taken", map[string]any{"min": counts.Approved})
		}
		if err := q.SetCompQuota(ctx, store.SetCompQuotaParams{CompQuota: quota, ID: eventID}); err != nil {
			return fmt.Errorf("set comp quota of event %d: %w", eventID, err)
		}
		if err := audit.Record(ctx, tx, staffEntry(ctx, actor, "event.comp_quota", "event", eventID, &eventID,
			"设置免费入场名额", map[string]any{"compQuota": before}, map[string]any{"compQuota": quota})); err != nil {
			return err
		}
		out, err = s.compList(ctx, q, eventID)
		return err
	})
	if err != nil {
		return CompList{}, err
	}
	return out, nil
}

// ApproveCompRequest 批准：锁赛事行核对名额，发一个本人专用、限 1 人、只限本赛事的 PRICE=0 优惠码。
// 已处理过返回 COMP_REQUEST_REVIEWED；名额已满（或已关闭申请）返回 COMP_QUOTA_FULL。
func (s *Service) ApproveCompRequest(ctx context.Context, actor iam.Staff, id int64) (CompRequest, error) {
	var out CompRequest
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		req, err := lockPending(ctx, q, id)
		if err != nil {
			return err
		}
		quota, err := q.LockCompEvent(ctx, req.EventID)
		if err != nil {
			return fmt.Errorf("lock event %d: %w", req.EventID, err)
		}
		counts, err := q.CompCounts(ctx, req.EventID)
		if err != nil {
			return fmt.Errorf("count comp requests of event %d: %w", req.EventID, err)
		}
		if quota == nil || counts.Approved >= *quota {
			return apperr.New(http.StatusConflict, apperr.CodeCompQuotaFull)
		}
		actorID := actor.ID
		eventID := req.EventID
		ownerID := req.UserID
		one := int16(1)
		var couponID int64
		var code string
		err = idgen.Retry("coupons_code_key", func() error {
			return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
				code = compCode()
				cid, err := store.New(sp).InsertPromoCoupon(ctx, store.InsertPromoCouponParams{
					Code:          code,
					EventID:       &eventID,
					DiscountType:  pricing.DiscountPrice,
					DiscountValue: 0,
					Quota:         1,
					MaxRunners:    &one,
					OwnerUserID:   &ownerID,
					CreatedBy:     &actorID,
				})
				couponID = cid
				return err
			})
		})
		if err != nil {
			return fmt.Errorf("insert comp coupon: %w", err)
		}
		if err := q.ApproveCompRequest(ctx, store.ApproveCompRequestParams{
			CouponID: &couponID, ReviewedBy: &actorID, ReviewedAt: ptr(s.now().UTC()), ID: id,
		}); err != nil {
			return fmt.Errorf("approve comp request %d: %w", id, err)
		}
		row, err := q.GetCompRequest(ctx, id)
		if err != nil {
			return fmt.Errorf("load comp request %d: %w", id, err)
		}
		out = compFromRow(store.ListCompRequestsRow(row))
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "comp_request.approve", "comp_request", id, &eventID,
			fmt.Sprintf("批准免费入场：%s（%s）", req.ApplicantName, code),
			map[string]any{"status": CompPending}, map[string]any{"status": CompApproved, "couponId": couponID}))
	})
	if err != nil {
		return CompRequest{}, err
	}
	return out, nil
}

// RejectCompRequest 拒绝；note 会展示给申请人。
func (s *Service) RejectCompRequest(ctx context.Context, actor iam.Staff, id int64, note string) (CompRequest, error) {
	if utf8.RuneCountInString(strings.TrimSpace(note)) > 200 {
		return CompRequest{}, validationError().WithField("note", "field.too_long", map[string]any{"max": 200})
	}
	var out CompRequest
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		req, err := lockPending(ctx, q, id)
		if err != nil {
			return err
		}
		actorID := actor.ID
		if err := q.RejectCompRequest(ctx, store.RejectCompRequestParams{
			ReviewNote: optText(note), ReviewedBy: &actorID, ReviewedAt: ptr(s.now().UTC()), ID: id,
		}); err != nil {
			return fmt.Errorf("reject comp request %d: %w", id, err)
		}
		row, err := q.GetCompRequest(ctx, id)
		if err != nil {
			return fmt.Errorf("load comp request %d: %w", id, err)
		}
		out = compFromRow(store.ListCompRequestsRow(row))
		eventID := req.EventID
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "comp_request.reject", "comp_request", id, &eventID,
			fmt.Sprintf("拒绝免费入场：%s", req.ApplicantName),
			map[string]any{"status": CompPending}, map[string]any{"status": CompRejected, "note": optText(note)}))
	})
	if err != nil {
		return CompRequest{}, err
	}
	return out, nil
}

func lockPending(ctx context.Context, q *store.Queries, id int64) (store.LockCompRequestRow, error) {
	req, err := q.LockCompRequest(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return req, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return req, fmt.Errorf("lock comp request %d: %w", id, err)
	}
	if req.Status != CompPending {
		return req, apperr.New(http.StatusConflict, apperr.CodeCompRequestReviewed)
	}
	return req, nil
}

func compCode() string {
	return idgen.Code(compCodePrefix)
}

func ptr[T any](v T) *T { return &v }

// withSavepoint 在保存点里执行 fn，失败时回滚到保存点，外层事务仍可继续（唯一冲突重试用）。
func withSavepoint(ctx context.Context, tx pgx.Tx, fn func(pgx.Tx) error) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin savepoint: %w", err)
	}
	if err := fn(sp); err != nil {
		_ = sp.Rollback(ctx)
		return err
	}
	return sp.Commit(ctx)
}

func staffEntry(ctx context.Context, actor iam.Staff, action, entityType string, entityID int64, eventID *int64, summary string, before, after any) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: entityType,
		EntityID:   entityID,
		EventID:    eventID,
		Summary:    summary,
		Before:     before,
		After:      after,
		Meta:       httpx.MetaOf(ctx),
	}
}
