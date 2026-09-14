package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing/store"
)

const (
	couponDescriptionMaxLen = 200
	couponMaxRunners        = 10
)

var couponCodePattern = regexp.MustCompile(`^[A-Z0-9_-]{3,32}$`)

func init() {
	apperr.RegisterConstraint("coupons_code_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeCouponCodeTaken).
			WithField("code", apperr.CodeCouponCodeTaken, nil)
	})
}

// NormalizeCouponCode 去掉首尾空白并转大写。录入与下单时都先规范化。
func NormalizeCouponCode(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// ValidateCoupon 校验新建优惠码的输入（Code 应已规范化），一次返回全部字段错误。
func ValidateCoupon(in CouponInput) error {
	return validateCoupon(in, true)
}

func validateCoupon(in CouponInput, withCode bool) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}

	if withCode && !couponCodePattern.MatchString(in.Code) {
		add("code", "field.coupon_code_format", nil)
	}
	switch in.DiscountType {
	case DiscountPercent:
		if in.DiscountValue < 1 || in.DiscountValue > 100 {
			add("discountValue", "field.percent_range", nil)
		}
	case DiscountAmount:
		if in.DiscountValue <= 0 {
			add("discountValue", "field.must_be_positive", nil)
		}
	case DiscountWaiver:
		if in.DiscountValue != 0 {
			add("discountValue", "field.invalid", nil)
		}
	default:
		add("discountType", "field.invalid", nil)
	}
	if in.Quota < 1 {
		add("quota", "field.must_be_positive", nil)
	}
	if in.MinRunners != nil && (*in.MinRunners < 1 || *in.MinRunners > couponMaxRunners) {
		add("minRunners", "field.invalid", nil)
	}
	if in.ValidFrom != nil && in.ValidUntil != nil && !in.ValidUntil.After(*in.ValidFrom) {
		add("validUntil", "field.ends_before_starts", nil)
	}
	if in.Status != CouponActive && in.Status != CouponDisabled {
		add("status", "field.invalid", nil)
	}
	for _, l := range requiredLangs {
		if utf8.RuneCountInString(in.Description[l]) > couponDescriptionMaxLen {
			add("description."+string(l), "field.too_long", map[string]any{"max": couponDescriptionMaxLen})
		}
	}

	if failed {
		return verr
	}
	return nil
}

// ListCoupons：eventID 非 nil 时只返回绑定该赛事的优惠码，nil 时返回全部；按创建时间倒序。
func (s *Service) ListCoupons(ctx context.Context, eventID *int64) ([]Coupon, error) {
	rows, err := store.New(s.pool).ListCoupons(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list coupons: %w", err)
	}
	out := make([]Coupon, 0, len(rows))
	for _, r := range rows {
		c, err := couponFromRow(r)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

// CreateCoupon 新建优惠码，写审计 coupon.create。优惠码重复返回 COUPON_CODE_TAKEN。
func (s *Service) CreateCoupon(ctx context.Context, actor iam.Staff, in CouponInput) (Coupon, error) {
	in.Code = NormalizeCouponCode(in.Code)
	if err := ValidateCoupon(in); err != nil {
		return Coupon{}, err
	}
	description, err := encodeDescription(in.Description)
	if err != nil {
		return Coupon{}, err
	}

	var out Coupon
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := requireCouponEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		actorID := actor.ID
		row, err := q.InsertCoupon(ctx, store.InsertCouponParams{
			Code:          in.Code,
			EventID:       in.EventID,
			DiscountType:  in.DiscountType,
			DiscountValue: in.DiscountValue,
			Quota:         in.Quota,
			MinRunners:    in.MinRunners,
			ValidFrom:     in.ValidFrom,
			ValidUntil:    in.ValidUntil,
			Description:   description,
			Status:        in.Status,
			CreatedBy:     &actorID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		c, err := couponFromRow(row)
		if err != nil {
			return err
		}
		out = c
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "coupon.create", "coupon", c.ID, c.Input.EventID,
			fmt.Sprintf("新建优惠码 %s（%s %d）", c.Input.Code, c.Input.DiscountType, c.Input.DiscountValue),
			nil, couponSnapshot(c)))
	})
	if err != nil {
		return Coupon{}, err
	}
	return out, nil
}

// UpdateCoupon 修改优惠码（Code 不可改，忽略 in.Code），写审计 coupon.update。
func (s *Service) UpdateCoupon(ctx context.Context, actor iam.Staff, id int64, in CouponInput) (Coupon, error) {
	if err := validateCoupon(in, false); err != nil {
		return Coupon{}, err
	}
	description, err := encodeDescription(in.Description)
	if err != nil {
		return Coupon{}, err
	}

	var out Coupon
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetCouponForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock coupon %d: %w", id, err)
		}
		before, err := couponFromRow(row)
		if err != nil {
			return err
		}
		if err := requireCouponEvent(ctx, q, in.EventID); err != nil {
			return err
		}
		if taken := row.UsedCount + row.ReservedCount; in.Quota < taken {
			return validationError().WithField("quota", "field.quota_below_taken", map[string]any{"min": taken})
		}
		updatedRow, err := q.UpdateCoupon(ctx, store.UpdateCouponParams{
			EventID:       in.EventID,
			DiscountType:  in.DiscountType,
			DiscountValue: in.DiscountValue,
			Quota:         in.Quota,
			MinRunners:    in.MinRunners,
			ValidFrom:     in.ValidFrom,
			ValidUntil:    in.ValidUntil,
			Description:   description,
			Status:        in.Status,
			ID:            id,
		})
		if err != nil {
			return fmt.Errorf("update coupon %d: %w", id, err)
		}
		after, err := couponFromRow(updatedRow)
		if err != nil {
			return err
		}
		out = after
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "coupon.update", "coupon", after.ID, after.Input.EventID,
			fmt.Sprintf("修改优惠码 %s", after.Input.Code), couponSnapshot(before), couponSnapshot(after)))
	})
	if err != nil {
		return Coupon{}, err
	}
	return out, nil
}

// requireCouponEvent：绑定的赛事不存在时返回字段错误（而不是 404，因为赛事 id 来自请求体）。
func requireCouponEvent(ctx context.Context, q *store.Queries, eventID *int64) error {
	if eventID == nil {
		return nil
	}
	exists, err := q.EventExists(ctx, *eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", *eventID, err)
	}
	if !exists {
		return validationError().WithField("eventId", "field.invalid", nil)
	}
	return nil
}

func encodeDescription(t i18n.Text) ([]byte, error) {
	if t == nil {
		return nil, nil
	}
	b, err := json.Marshal(t)
	if err != nil {
		return nil, fmt.Errorf("encode coupon description: %w", err)
	}
	return b, nil
}

func couponFromRow(r store.Coupon) (Coupon, error) {
	var description i18n.Text
	if len(r.Description) > 0 {
		if err := json.Unmarshal(r.Description, &description); err != nil {
			return Coupon{}, fmt.Errorf("decode description of coupon %d: %w", r.ID, err)
		}
	}
	return Coupon{
		ID: r.ID,
		Input: CouponInput{
			Code:          r.Code,
			EventID:       r.EventID,
			DiscountType:  r.DiscountType,
			DiscountValue: r.DiscountValue,
			Quota:         r.Quota,
			MinRunners:    r.MinRunners,
			ValidFrom:     r.ValidFrom,
			ValidUntil:    r.ValidUntil,
			Description:   description,
			Status:        r.Status,
		},
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}, nil
}

func couponSnapshot(c Coupon) map[string]any {
	return map[string]any{
		"code":          c.Input.Code,
		"eventId":       c.Input.EventID,
		"discountType":  c.Input.DiscountType,
		"discountValue": c.Input.DiscountValue,
		"quota":         c.Input.Quota,
		"minRunners":    c.Input.MinRunners,
		"validFrom":     c.Input.ValidFrom,
		"validUntil":    c.Input.ValidUntil,
		"status":        c.Input.Status,
	}
}
