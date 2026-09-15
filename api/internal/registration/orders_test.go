package registration_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
	fx "werun/api/internal/testfixture"
)

func TestCancelOrderReleasesReservation(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	in := e.input("cancel-key-0001",
		fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"),
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	in.CouponCode = "RUN20"
	d, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	require.NoError(t, err)

	cancelled, err := e.svc.CancelOrder(ctx, e.user, d.OrderNo, testMeta)

	require.NoError(t, err)
	require.Equal(t, registration.StatusCancelled, cancelled.Status)
	require.Equal(t, "RELEASED", cancelled.ReservationState)
	require.Nil(t, cancelled.DeadlineAt)
	for _, p := range cancelled.Participants {
		require.Equal(t, registration.RegistrationCancelled, p.RegistrationStatus)
		require.Nil(t, p.TicketCode)
	}
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{}, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RELEASED'`, d.ID))
	require.Equal(t, 2, fx.Count(t, e.pool,
		`SELECT count(*) FROM registrations WHERE status = 'CANCELLED' AND cancel_reason = 'ORDER_CANCELLED'`))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND cancelled_at IS NOT NULL AND reservation_release_kind = 'ORDER_CANCELLED'`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'reg_order.cancel' AND entity_id = $1 AND actor_type = 'USER' AND actor_id = $2 AND is_financial`,
		d.ID, e.user.ID))

	_, err = e.svc.CancelOrder(ctx, e.user, d.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("cancel-key-0002", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err, "取消后的报名不再算已报名")
}

// TestCancelOrderGuardLeavesOtherOrdersReservationsIntact 覆盖控制者补充的释放保护：
// pricing.Release 本身不幂等，若没有订单级条件更新做门槛，重复释放 A 会在共享的组别/价格档/优惠码计数上
// 多扣一次，误伤同组别、同价格档、同优惠码下持有预留的另一张订单 B。
func TestCancelOrderGuardLeavesOtherOrdersReservationsIntact(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})

	inA := e.input("guard-key-a", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"))
	inA.CouponCode = "RUN20"
	a, err := e.svc.CreateOrder(ctx, e.user, inA, testMeta)
	require.NoError(t, err)

	inB := e.input("guard-key-b", fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	inB.CouponCode = "RUN20"
	b, err := e.svc.CreateOrder(ctx, e.user, inB, testMeta)
	require.NoError(t, err)

	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "coupons", coupon))

	_, err = e.svc.CancelOrder(ctx, e.user, a.OrderNo, testMeta)
	require.NoError(t, err)

	afterFirstCancel := fx.Counts{Reserved: 1}
	require.Equal(t, afterFirstCancel, e.counts(t, "event_categories", e.event.CategoryIDs[0]), "只释放 A 的一份预留")
	require.Equal(t, afterFirstCancel, e.counts(t, "price_rules", e.rule))
	require.Equal(t, afterFirstCancel, e.counts(t, "coupons", coupon))

	_, err = e.svc.CancelOrder(ctx, e.user, a.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)

	require.Equal(t, afterFirstCancel, e.counts(t, "event_categories", e.event.CategoryIDs[0]), "重复取消 A 不应再次释放")
	require.Equal(t, afterFirstCancel, e.counts(t, "price_rules", e.rule))
	require.Equal(t, afterFirstCancel, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PENDING_PAYMENT' AND reservation_state = 'RESERVED'`, b.ID),
		"订单 B 的预留不受影响")
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RESERVED'`, b.ID))
}

func TestCancelOrderRules(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	d, err := e.svc.CreateOrder(ctx, e.user, e.input("rules-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)

	other := fx.Runner(t, e.pool, 900010, "Other")
	_, err = e.svc.CancelOrder(ctx, other, d.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)
	_, err = e.svc.CancelOrder(ctx, e.user, "WR00000000", testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	fx.Exec(t, e.pool, `UPDATE reg_orders SET status = 'PROOF_SUBMITTED', deadline_at = NULL WHERE id = $1`, d.ID)
	_, err = e.svc.CancelOrder(ctx, e.user, d.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	fx.Coupon(t, e.pool, fx.CouponOpts{Code: "FREE1", DiscountType: "WAIVER", Quota: 1})
	freeIn := e.input("rules-key-0002", fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01"))
	freeIn.CouponCode = "FREE1"
	paid, err := e.svc.CreateOrder(ctx, e.user, freeIn, testMeta)
	require.NoError(t, err)
	_, err = e.svc.CancelOrder(ctx, e.user, paid.OrderNo, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, fx.Counts{Used: 1, Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
}

func TestReleaseOrderExpiredReleasesOnlyOnce(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	d, err := e.svc.CreateOrder(ctx, e.user, e.input("expire-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)
	release := func(kind registration.ReleaseKind) (bool, error) {
		var released bool
		err := db.InTx(ctx, e.pool, func(tx pgx.Tx) error {
			r, err := e.svc.ReleaseOrder(ctx, tx, d.ID, kind)
			released = r
			return err
		})
		return released, err
	}

	released, err := release(registration.ReleaseExpired)
	require.NoError(t, err)
	require.True(t, released)
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'EXPIRED' AND reservation_state = 'RELEASED'
		 AND reservation_release_kind = 'ORDER_EXPIRED' AND expired_at IS NOT NULL AND deadline_at IS NULL`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE status = 'CANCELLED' AND cancel_reason = 'ORDER_EXPIRED'`))
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	released, err = release(registration.ReleaseExpired)
	require.NoError(t, err)
	require.False(t, released, "条件更新保证只释放一次")
	released, err = release(registration.ReleaseCancelled)
	require.NoError(t, err)
	require.False(t, released)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{}, e.counts(t, "price_rules", e.rule))
}

func TestGetMyOrder(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	d, err := e.svc.CreateOrder(ctx, e.user, e.input("get-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)

	got, err := e.svc.GetMyOrder(ctx, e.user, d.OrderNo)
	require.NoError(t, err)
	require.Equal(t, d.OrderNo, got.OrderNo)
	require.Equal(t, d.AmountCents, got.AmountCents)
	require.Equal(t, e.account, got.PaymentAccount.ID)
	require.Len(t, got.Participants, 1)
	require.Nil(t, got.Participants[0].TicketCode)
	require.Nil(t, got.LastRejection)

	other := fx.Runner(t, e.pool, 900011, "Other")
	_, err = e.svc.GetMyOrder(ctx, other, d.OrderNo)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	now := e.clock.Now()
	fx.Exec(t, e.pool, `UPDATE reg_orders SET status = 'PROOF_REJECTED', deadline_at = $2 WHERE id = $1`, d.ID, now.Add(24*time.Hour))
	fx.RejectedProof(t, e.pool, d.ID, e.account, "AMOUNT_MISMATCH", nil, now.Add(-2*time.Hour))
	fx.RejectedProof(t, e.pool, d.ID, e.account, "UNREADABLE", fx.Ptr("截图看不清"), now.Add(-time.Hour))

	got, err = e.svc.GetMyOrder(ctx, e.user, d.OrderNo)
	require.NoError(t, err)
	require.Equal(t, registration.StatusProofRejected, got.Status)
	require.NotNil(t, got.LastRejection)
	require.Equal(t, "UNREADABLE", got.LastRejection.Code)
	require.Equal(t, "截图看不清", *got.LastRejection.Reason)
	require.True(t, got.LastRejection.ReviewedAt.Equal(now.Add(-time.Hour)))

	fx.Coupon(t, e.pool, fx.CouponOpts{Code: "FREE1", DiscountType: "WAIVER", Quota: 1})
	freeIn := e.input("get-key-0002", fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01"))
	freeIn.CouponCode = "FREE1"
	paid, err := e.svc.CreateOrder(ctx, e.user, freeIn, testMeta)
	require.NoError(t, err)
	got, err = e.svc.GetMyOrder(ctx, e.user, paid.OrderNo)
	require.NoError(t, err)
	require.NotNil(t, got.Participants[0].TicketCode, "已确认的报名返回参赛凭证码")
}

func TestListMyOrders(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	first, err := e.svc.CreateOrder(ctx, e.user, e.input("list-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	require.NoError(t, err)
	second, err := e.svc.CreateOrder(ctx, e.user, e.input("list-key-0002",
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"),
		fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01")), testMeta)
	require.NoError(t, err)
	other := fx.Runner(t, e.pool, 900012, "Other")
	_, err = e.svc.CreateOrder(ctx, other, e.input("list-key-0003", fx.Profile("Other Runner", "O123456", "KH", "1990-01-01")), testMeta)
	require.NoError(t, err)

	list, err := e.svc.ListMyOrders(ctx, e.user)

	require.NoError(t, err)
	require.Len(t, list, 2)
	require.Equal(t, second.OrderNo, list[0].OrderNo)
	require.Equal(t, 2, list[0].ParticipantCount)
	require.Equal(t, second.AmountCents, list[0].AmountCents)
	require.Equal(t, first.OrderNo, list[1].OrderNo)
	require.Equal(t, 1, list[1].ParticipantCount)
	require.Equal(t, "pphm-2026", list[1].EventSlug)
	require.Equal(t, "Phnom Penh Half Marathon 2026", list[1].EventName[i18n.EN])
	require.NotNil(t, list[1].DeadlineAt)
}
