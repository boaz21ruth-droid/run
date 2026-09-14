package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func couponBody(code string, eventID *int64) map[string]any {
	return map[string]any{
		"code":          code,
		"eventId":       eventID,
		"discountType":  "PERCENT",
		"discountValue": 20,
		"quota":         50,
		"minRunners":    2,
		"validFrom":     nil,
		"validUntil":    "2026-10-31T23:59:00+07:00",
		"status":        "ACTIVE",
	}
}

func TestCouponsHTTP(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.couponhttp")
	support := env.sessionCookie(t, iam.RoleSupport, "support.couponhttp")
	ev := env.createPublishedEvent(t, ops)

	rec := env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("early_2026", &ev.Id), support, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 对 coupon_manage 只读")

	rec = env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("early_2026", &ev.Id), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.Coupon](t, rec)
	require.Equal(t, "EARLY_2026", created.Code)
	require.Equal(t, ev.Id, *created.EventId)
	require.Equal(t, int32(2), *created.MinRunners)
	require.Nil(t, created.Description)

	rec = env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("WERUN_ALL", nil), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = env.do(t, http.MethodGet, fmt.Sprintf("/api/admin/coupons?eventId=%d", ev.Id), nil, support, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.CouponList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, "EARLY_2026", list.Items[0].Code)

	rec = env.do(t, http.MethodGet, "/api/admin/coupons", nil, support, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, eventsDecode[apigen.CouponList](t, rec).Items, 2)

	rec = env.do(t, http.MethodPost, "/api/admin/coupons", couponBody("Early_2026", nil), ops, adminClientHeader)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	dup := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeCouponCodeTaken, dup.Error.Code)
	require.Contains(t, dup.Error.Fields, "code")

	bad := couponBody("BIG_DEAL", nil)
	bad["discountValue"] = 150
	rec = env.do(t, http.MethodPost, "/api/admin/coupons", bad, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "discountValue")

	update := couponBody("IGNORED", &ev.Id)
	delete(update, "code")
	update["status"] = "DISABLED"
	rec = env.do(t, http.MethodPut, fmt.Sprintf("/api/admin/coupons/%d", created.Id), update, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	updated := eventsDecode[apigen.Coupon](t, rec)
	require.Equal(t, "EARLY_2026", updated.Code)
	require.Equal(t, apigen.CouponStatus("DISABLED"), updated.Status)

	rec = env.do(t, http.MethodPut, "/api/admin/coupons/999999", update, ops, adminClientHeader)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
