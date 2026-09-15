package registration_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
)

func orderNos(items []registration.OrderSummary) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.OrderNo)
	}
	return out
}

func TestAdminListOrdersFiltersSearchesAndPaginates(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fxA := paytest.SeedEvent(t, env.Pool)
	fxB := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7201, "Sokha Chan")
	o1 := paytest.SeedOrder(t, env, fxA, u, paytest.OrderSpec{BuyerName: "Sokha Chan", BuyerPhone: "+85512000001"})
	o2 := paytest.SeedOrder(t, env, fxA, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED", Participants: 2, BuyerName: "Dara Meas", BuyerPhone: "+85512000002"})
	o3 := paytest.SeedOrder(t, env, fxB, u, paytest.OrderSpec{BuyerName: "Vanna_Test", BuyerPhone: "+85598000003"})
	for i, o := range []paytest.OrderRef{o1, o2, o3} {
		_, err := env.Pool.Exec(ctx, `UPDATE reg_orders SET created_at = $2 WHERE id = $1`,
			o.ID, env.Clock.Now().Add(time.Duration(i-10)*time.Minute))
		require.NoError(t, err)
	}

	list := func(f registration.AdminOrderFilter) ([]string, int64) {
		t.Helper()
		items, total, err := env.Orders.AdminListOrders(ctx, f)
		require.NoError(t, err)
		return orderNos(items), total
	}

	got, total := list(registration.AdminOrderFilter{})
	require.Equal(t, []string{o3.OrderNo, o2.OrderNo, o1.OrderNo}, got)
	require.EqualValues(t, 3, total)

	got, total = list(registration.AdminOrderFilter{EventID: &fxA.EventID})
	require.Equal(t, []string{o2.OrderNo, o1.OrderNo}, got)
	require.EqualValues(t, 2, total)

	items, total, err := env.Orders.AdminListOrders(ctx, registration.AdminOrderFilter{Status: "PROOF_SUBMITTED"})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Len(t, items, 1)
	require.Equal(t, o2.OrderNo, items[0].OrderNo)
	require.Equal(t, 2, items[0].ParticipantCount)
	require.Equal(t, o2.AmountCents, items[0].AmountCents)
	require.True(t, strings.HasPrefix(items[0].EventSlug, "paytest-"))
	require.Equal(t, "Phnom Penh Half Marathon 2026", items[0].EventName[i18n.EN])

	got, _ = list(registration.AdminOrderFilter{Query: " " + strings.ToLower(o1.OrderNo) + " "})
	require.Equal(t, []string{o1.OrderNo}, got)
	got, _ = list(registration.AdminOrderFilter{Query: "98000"})
	require.Equal(t, []string{o3.OrderNo}, got)
	got, _ = list(registration.AdminOrderFilter{Query: "dara"})
	require.Equal(t, []string{o2.OrderNo}, got)
	got, _ = list(registration.AdminOrderFilter{Query: "_"})
	require.Equal(t, []string{o3.OrderNo}, got, "下划线必须按字面匹配")

	got, total = list(registration.AdminOrderFilter{Limit: 2})
	require.Equal(t, []string{o3.OrderNo, o2.OrderNo}, got)
	require.EqualValues(t, 3, total)
	got, total = list(registration.AdminOrderFilter{Limit: 2, Offset: 2})
	require.Equal(t, []string{o1.OrderNo}, got)
	require.EqualValues(t, 3, total)
	got, _ = list(registration.AdminOrderFilter{Limit: 500, Offset: -3})
	require.Len(t, got, 3)

	_, _, err = env.Orders.AdminListOrders(ctx, registration.AdminOrderFilter{Status: "BOGUS"})
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	require.Equal(t, "field.invalid", ae.Fields["status"].Key)
}

func TestAdminGetOrderIncludesBuyerProofsReceiptsAndCoupon(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7202, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED", WithCoupon: true, BuyerPhone: "+85512000009"})
	rejectedID := paytest.SeedProof(t, env, fx, order, u, "REJECTED", "ABA-OLD-001", env.Clock.Now().Add(-3*time.Hour))
	submittedID := paytest.SeedProof(t, env, fx, order, u, "SUBMITTED", "ABA-NEW-002", env.Clock.Now().Add(-time.Hour))
	_, err := env.Pool.Exec(ctx, `
		INSERT INTO payment_receipts (payment_account_id, txn_ref, amount_cents, currency, received_at, reg_order_id, match_status, recorded_by_type)
		VALUES ($1, 'ABA-BANK-777', $2, 'USD', $3, $4, 'APPLIED', 'SYSTEM')`,
		fx.AccountID, order.AmountCents, env.Clock.Now().Add(-30*time.Minute), order.ID)
	require.NoError(t, err)

	detail, err := env.Orders.AdminGetOrder(ctx, order.ID)

	require.NoError(t, err)
	require.Equal(t, order.OrderNo, detail.OrderNo)
	require.Equal(t, "PROOF_SUBMITTED", detail.Status)
	require.Equal(t, "Sokha Chan", detail.BuyerName)
	require.Equal(t, "+85512000009", detail.BuyerPhone)
	require.Equal(t, order.AmountCents, detail.AmountCents)
	require.Equal(t, fx.AccountID, detail.PaymentAccount.ID)
	require.Len(t, detail.Participants, 1)
	require.Equal(t, "Sokha Chan", detail.Participants[0].FullName)

	require.Len(t, detail.Proofs, 2)
	require.Equal(t, submittedID, detail.Proofs[0].ID)
	require.Equal(t, "SUBMITTED", detail.Proofs[0].Status)
	require.Equal(t, rejectedID, detail.Proofs[1].ID)
	require.Equal(t, "REJECTED", detail.Proofs[1].Status)
	require.NotNil(t, detail.Proofs[1].RejectCode)
	require.Equal(t, "UNREADABLE", *detail.Proofs[1].RejectCode)
	require.NotNil(t, detail.Proofs[1].ReviewedAt)

	require.Len(t, detail.Receipts, 1)
	require.Equal(t, "ABA-BANK-777", detail.Receipts[0].TxnRef)
	require.Equal(t, "APPLIED", detail.Receipts[0].MatchStatus)

	require.NotNil(t, detail.Coupon)
	require.Equal(t, paytest.CouponDiscountCents, detail.Coupon.DiscountCents)
	require.Equal(t, "RESERVED", detail.Coupon.State)
	require.True(t, strings.HasPrefix(detail.Coupon.Code, "PAY"))
}

func TestAdminGetOrderWithoutCouponOrProofs(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7203, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})

	detail, err := env.Orders.AdminGetOrder(context.Background(), order.ID)

	require.NoError(t, err)
	require.Nil(t, detail.Coupon)
	require.NotNil(t, detail.Proofs)
	require.Empty(t, detail.Proofs)
	require.NotNil(t, detail.Receipts)
	require.Empty(t, detail.Receipts)
}

func TestAdminGetOrderUnknown(t *testing.T) {
	env := paytest.NewEnv(t)

	_, err := env.Orders.AdminGetOrder(context.Background(), 999999)

	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeOrderNotFound, ae.Code)
	require.Equal(t, http.StatusNotFound, ae.Status)
}
