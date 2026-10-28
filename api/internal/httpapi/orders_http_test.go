package httpapi_test

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func TestFinanceListsAndOpensOrders(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7301, "Sokha Chan")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{WithCoupon: true})
	paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED"})
	finance := env.staffCookie(t, iam.RoleFinance, "finance.orders")

	query := url.Values{
		"eventId": {fmt.Sprint(fx.EventID)},
		"status":  {"PENDING_PAYMENT"},
		"q":       {strings.ToLower(order.OrderNo)},
		"limit":   {"10"},
	}
	rec := env.adminRequest(t, http.MethodGet, "/api/admin/orders?"+query.Encode(), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := paymentDecode[apigen.AdminOrderList](t, rec)
	require.EqualValues(t, 1, list.Total)
	require.Len(t, list.Items, 1)
	require.Equal(t, order.OrderNo, list.Items[0].OrderNo)
	require.Equal(t, apigen.AdminOrderSummaryStatusPENDINGPAYMENT, list.Items[0].Status)
	require.NotNil(t, list.Items[0].EventName.En)
	require.Equal(t, "Phnom Penh Half Marathon 2026", *list.Items[0].EventName.En)
	require.EqualValues(t, 1, list.Items[0].ParticipantCount)

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/orders/%d", order.ID), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := paymentDecode[apigen.AdminOrderDetail](t, rec)
	require.Equal(t, order.OrderNo, detail.OrderNo)
	require.Equal(t, order.AmountCents, detail.AmountCents)
	require.Len(t, detail.Participants, 1)
	require.NotNil(t, detail.Coupon)
	require.Equal(t, apigen.AdminAppliedCouponStateRESERVED, detail.Coupon.State)
	require.Empty(t, detail.Proofs)
	require.Equal(t, fx.AccountID, detail.PaymentAccount.Id)

	rec = env.adminRequest(t, http.MethodGet, "/api/admin/orders/999999", nil, finance)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeOrderNotFound, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.adminRequest(t, http.MethodGet, "/api/admin/orders?status=BOGUS", nil, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}

func TestPhotographerCannotViewOrders(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7302, "Sokha Chan")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})
	photographer := env.staffCookie(t, iam.RolePhotographer, "photog.orders")

	for _, path := range []string{"/api/admin/orders", fmt.Sprintf("/api/admin/orders/%d", order.ID)} {
		rec := env.adminRequest(t, http.MethodGet, path, nil, photographer)
		require.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", path, rec.Body.String())
		require.Equal(t, apperr.CodeForbidden, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	}

	rec := env.adminRequest(t, http.MethodGet, "/api/admin/orders", nil, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
}

// 赛事范围校验（auth.go 的 TODO(spec §5.1 step 7)）补齐前，RACE_SUPERVISOR / RACE_STAFF 不能看任何赛事的订单，
// 否则会读到未被指派赛事的跑者个人信息。
func TestRaceRolesCannotViewOrders(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7303, "Sokha Chan")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})

	for role, username := range map[iam.Role]string{iam.RoleRaceSupervisor: "race.supervisor", iam.RoleRaceStaff: "race.staff"} {
		cookie := env.staffCookie(t, role, username)
		for _, path := range []string{"/api/admin/orders", fmt.Sprintf("/api/admin/orders/%d", order.ID)} {
			rec := env.adminRequest(t, http.MethodGet, path, nil, cookie)
			require.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", role, path, rec.Body.String())
			require.Equal(t, apperr.CodeForbidden, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
		}
	}
}
