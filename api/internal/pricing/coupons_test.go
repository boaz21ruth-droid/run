package pricing_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
)

func ptrInt16(v int16) *int16 { return &v }

func validCoupon(eventID *int64) pricing.CouponInput {
	return pricing.CouponInput{
		Code:          "EARLY_2026",
		EventID:       eventID,
		DiscountType:  pricing.DiscountPercent,
		DiscountValue: 20,
		Quota:         50,
		MinRunners:    ptrInt16(2),
		ValidFrom:     ptrTime("2026-09-20T00:00:00+07:00"),
		ValidUntil:    ptrTime("2026-10-31T23:59:00+07:00"),
		Description:   i18n.Text{i18n.ZH: "早鸟两人同行", i18n.EN: "Early pair", i18n.KM: "គូទិញមុន"},
		Status:        pricing.CouponActive,
	}
}

func TestNormalizeCouponCode(t *testing.T) {
	assert.Equal(t, "EARLY_2026", pricing.NormalizeCouponCode("  early_2026\t"))
	assert.Equal(t, "RUN-KH", pricing.NormalizeCouponCode("run-kh"))
}

func TestValidateCoupon(t *testing.T) {
	require.NoError(t, pricing.ValidateCoupon(validCoupon(nil)))
	amount := validCoupon(nil)
	amount.DiscountType = pricing.DiscountAmount
	amount.DiscountValue = 500
	require.NoError(t, pricing.ValidateCoupon(amount))
	waiver := validCoupon(nil)
	waiver.DiscountType = pricing.DiscountWaiver
	waiver.DiscountValue = 0
	waiver.MinRunners = nil
	waiver.Description = nil
	require.NoError(t, pricing.ValidateCoupon(waiver))

	cases := []struct {
		name   string
		mutate func(in *pricing.CouponInput)
		field  string
		key    string
	}{
		{"太短", func(in *pricing.CouponInput) { in.Code = "AB" }, "code", "field.coupon_code_format"},
		{"含空格", func(in *pricing.CouponInput) { in.Code = "EARLY 2026" }, "code", "field.coupon_code_format"},
		{"太长", func(in *pricing.CouponInput) { in.Code = strings.Repeat("A", 33) }, "code", "field.coupon_code_format"},
		{"类型不在枚举内", func(in *pricing.CouponInput) { in.DiscountType = "BOGO" }, "discountType", "field.invalid"},
		{"百分比为 0", func(in *pricing.CouponInput) { in.DiscountValue = 0 }, "discountValue", "field.percent_range"},
		{"百分比超过 100", func(in *pricing.CouponInput) { in.DiscountValue = 101 }, "discountValue", "field.percent_range"},
		{"固定金额为 0", func(in *pricing.CouponInput) {
			in.DiscountType = pricing.DiscountAmount
			in.DiscountValue = 0
		}, "discountValue", "field.must_be_positive"},
		{"免单带金额", func(in *pricing.CouponInput) {
			in.DiscountType = pricing.DiscountWaiver
			in.DiscountValue = 5
		}, "discountValue", "field.invalid"},
		{"次数为 0", func(in *pricing.CouponInput) { in.Quota = 0 }, "quota", "field.must_be_positive"},
		{"最少人数 11", func(in *pricing.CouponInput) { in.MinRunners = ptrInt16(11) }, "minRunners", "field.invalid"},
		{"有效期倒置", func(in *pricing.CouponInput) { in.ValidUntil = ptrTime("2026-09-01T00:00:00+07:00") }, "validUntil", "field.ends_before_starts"},
		{"状态不在枚举内", func(in *pricing.CouponInput) { in.Status = "PAUSED" }, "status", "field.invalid"},
		{"说明过长", func(in *pricing.CouponInput) { in.Description[i18n.EN] = strings.Repeat("a", 201) }, "description.en", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validCoupon(nil)
			tc.mutate(&in)

			err := pricing.ValidateCoupon(in)

			require.Equal(t, tc.key, fieldKeys(t, err)[tc.field], "fields=%v", fieldKeys(t, err))
		})
	}
}

func TestCreateAndListCoupons(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()

	eventCoupon := validCoupon(&f.event.ID)
	eventCoupon.Code = "  early_2026 "
	created, err := f.svc.CreateCoupon(ctx, f.actor, eventCoupon)
	require.NoError(t, err)
	global := validCoupon(nil)
	global.Code = "WERUN-FREE"
	global.DiscountType = pricing.DiscountWaiver
	global.DiscountValue = 0
	global.Description = nil
	_, err = f.svc.CreateCoupon(ctx, f.actor, global)
	require.NoError(t, err)

	assert.Equal(t, "EARLY_2026", created.Input.Code)
	assert.Equal(t, f.event.ID, *created.Input.EventID)
	assert.Equal(t, int16(2), *created.Input.MinRunners)
	assert.Equal(t, "Early pair", created.Input.Description[i18n.EN])
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM coupons WHERE code = 'EARLY_2026' AND created_by = $1`, f.actor.ID))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'coupon.create' AND entity_type = 'coupon'
		   AND entity_id = $1 AND event_id = $2 AND NOT is_financial`, created.ID, f.event.ID))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM audit_logs WHERE action = 'coupon.create' AND event_id IS NULL`))

	all, err := f.svc.ListCoupons(ctx, nil)
	require.NoError(t, err)
	assert.Len(t, all, 2)
	forEvent, err := f.svc.ListCoupons(ctx, &f.event.ID)
	require.NoError(t, err)
	require.Len(t, forEvent, 1)
	assert.Equal(t, "EARLY_2026", forEvent[0].Input.Code)
	forOther, err := f.svc.ListCoupons(ctx, &f.other.ID)
	require.NoError(t, err)
	assert.Empty(t, forOther)
	waiver, err := f.svc.ListCoupons(ctx, nil)
	require.NoError(t, err)
	for _, c := range waiver {
		if c.Input.Code == "WERUN-FREE" {
			assert.Nil(t, c.Input.Description)
			assert.Nil(t, c.Input.EventID)
		}
	}
}

func TestCreateCouponRejectsDuplicateCodeAndUnknownEvent(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()
	_, err := f.svc.CreateCoupon(ctx, f.actor, validCoupon(nil))
	require.NoError(t, err)

	dup := validCoupon(&f.event.ID)
	dup.Code = "early_2026"
	_, err = f.svc.CreateCoupon(ctx, f.actor, dup)
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	assert.Equal(t, apperr.CodeCouponCodeTaken, ae.Code)
	assert.Equal(t, http.StatusConflict, ae.Status)
	assert.Equal(t, apperr.CodeCouponCodeTaken, fieldKeys(t, err)["code"])

	missing := int64(999999)
	unknown := validCoupon(&missing)
	unknown.Code = "GHOST"
	_, err = f.svc.CreateCoupon(ctx, f.actor, unknown)
	assert.Equal(t, "field.invalid", fieldKeys(t, err)["eventId"])
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM coupons`))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM audit_logs WHERE action = 'coupon.create'`))
}

func TestUpdateCoupon(t *testing.T) {
	f := newPricingFixture(t)
	ctx := context.Background()
	created, err := f.svc.CreateCoupon(ctx, f.actor, validCoupon(&f.event.ID))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE coupons SET used_count = 2, reserved_count = 1 WHERE id = $1`, created.ID)
	require.NoError(t, err)

	below := validCoupon(&f.event.ID)
	below.Quota = 2
	_, err = f.svc.UpdateCoupon(ctx, f.actor, created.ID, below)
	require.Equal(t, "field.quota_below_taken", fieldKeys(t, err)["quota"])
	ae, _ := apperr.As(err)
	assert.Equal(t, int32(3), ae.Fields["quota"].Params["min"])

	changed := validCoupon(nil)
	changed.Code = "SOMETHING_ELSE"
	changed.Quota = 3
	changed.Status = pricing.CouponDisabled
	changed.DiscountType = pricing.DiscountAmount
	changed.DiscountValue = 300
	updated, err := f.svc.UpdateCoupon(ctx, f.actor, created.ID, changed)

	require.NoError(t, err)
	assert.Equal(t, "EARLY_2026", updated.Input.Code, "优惠码不可改")
	assert.Equal(t, pricing.CouponDisabled, updated.Input.Status)
	assert.Nil(t, updated.Input.EventID)
	assert.Equal(t, int64(300), updated.Input.DiscountValue)
	assert.Equal(t, int32(2), updated.UsedCount)
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'coupon.update' AND entity_id = $1
		   AND before_data->>'status' = 'ACTIVE' AND after_data->>'status' = 'DISABLED'`, created.ID))

	invalidCode := validCoupon(nil)
	invalidCode.Code = "x" // 修改时不校验 code
	_, err = f.svc.UpdateCoupon(ctx, f.actor, created.ID, invalidCode)
	require.NoError(t, err)

	_, err = f.svc.UpdateCoupon(ctx, f.actor, 999999, changed)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
}
