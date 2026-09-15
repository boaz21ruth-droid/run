package registration_test

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
	fx "werun/api/internal/testfixture"
)

var testMeta = httpx.Meta{RequestID: "req-registration-test", IP: "203.0.113.7", UserAgent: "registration-test"}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type orderEnv struct {
	pool    *pgxpool.Pool
	clock   *fakeClock
	runners *runner.Service
	svc     *registration.Service
	event   fx.Event
	rule    int64
	account int64
	consent runner.ConsentAcceptance
	user    runner.User
}

func newOrderEnv(t *testing.T, capacity int32) orderEnv {
	t.Helper()
	pool := dbtest.NewPool(t)
	clock := &fakeClock{now: time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)}
	runners := fx.RunnerService(t, pool, clock.Now)
	prices := pricing.NewService(pool, clock.Now)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "pphm-2026", RegistrationOpen: true,
		Categories: []fx.CategoryOpts{{Code: "21K", Capacity: capacity, MinAge: 16}}})
	return orderEnv{
		pool:    pool,
		clock:   clock,
		runners: runners,
		svc:     registration.NewService(pool, runners, prices, clock.Now),
		event:   ev,
		rule:    fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs}),
		account: fx.PaymentAccount(t, pool, &ev.ID),
		consent: fx.RegistrationConsent(t, runners),
		user:    fx.Runner(t, pool, 900001, "Dara"),
	}
}

func (e orderEnv) input(key string, profiles ...runner.ProfileData) registration.CreateOrderInput {
	in := registration.CreateOrderInput{EventSlug: e.event.Slug, Consent: e.consent, IdempotencyKey: key}
	for _, p := range profiles {
		in.Participants = append(in.Participants, registration.OrderParticipantInput{CategoryID: e.event.CategoryIDs[0], Profile: &p})
	}
	return in
}

func (e orderEnv) counts(t *testing.T, table string, id int64) fx.Counts {
	t.Helper()
	return fx.CountersOf(t, e.pool, table, id)
}

// requireAppErr 断言错误码与状态码，返回错误的副本（值类型，便于读取 Fields）。
func requireAppErr(t *testing.T, err error, code string, status int) apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return *ae
}

func TestCreateOrderTwoParticipantsWithPercentCoupon(t *testing.T) {
	e := newOrderEnv(t, 100)
	ctx := context.Background()
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", EventID: &e.event.ID, DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	in := e.input("order-key-0001",
		fx.Profile("Chan Sophea", "N0 1234-567", "KH", "1990-05-01"),
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	in.CouponCode = "run20"
	in.Participants[1].SaveAsProfile = true

	d, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)

	require.NoError(t, err)
	require.Regexp(t, `^WR[0-9A-HJKMNP-TV-Z]{8}$`, d.OrderNo)
	require.Equal(t, registration.StatusPendingPayment, d.Status)
	require.Equal(t, "RESERVED", d.ReservationState)
	require.Equal(t, e.user.ID, d.BuyerUserID)
	require.Equal(t, int64(5000), d.ListAmountCents)
	require.Equal(t, int64(1001), d.DiscountCents)
	require.Equal(t, int64(1), d.IdentOffsetCents)
	require.Equal(t, int64(3999), d.AmountCents)
	require.Equal(t, "USD", d.Currency)
	require.Equal(t, e.account, d.PaymentAccountID)
	require.NotNil(t, d.DeadlineAt)
	require.True(t, d.DeadlineAt.Equal(e.clock.Now().Add(30*time.Minute)))
	require.Nil(t, d.PaidAt)
	require.Equal(t, "pphm-2026", d.EventSlug)
	require.Equal(t, "Phnom Penh Half Marathon 2026", d.EventName[i18n.EN])
	require.Equal(t, "Asia/Phnom_Penh", d.EventTimezone)
	require.Equal(t, e.account, d.PaymentAccount.ID)
	require.Equal(t, "ABA", d.PaymentAccount.Provider)
	require.Equal(t, "*** *** 123", d.PaymentAccount.AccountNoMasked)
	require.Nil(t, d.LastRejection)

	require.Len(t, d.Participants, 2)
	require.Regexp(t, `^RG[0-9A-HJKMNP-TV-Z]{8}$`, d.Participants[0].RegNo)
	require.Equal(t, "Chan Sophea", d.Participants[0].FullName)
	require.Equal(t, "21K 组", d.Participants[0].CategoryName[i18n.ZH])
	require.Equal(t, e.rule, d.Participants[0].PriceRuleID)
	require.Equal(t, int64(2500), d.Participants[0].ListPriceCents)
	require.Equal(t, int64(1999), d.Participants[0].PaidCents, "余数相同按参赛人顺序，第一个人多减 1 分")
	require.Equal(t, int64(2000), d.Participants[1].PaidCents)
	require.Equal(t, registration.RegistrationPending, d.Participants[0].RegistrationStatus)
	require.Nil(t, d.Participants[0].TicketCode)

	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "coupons", coupon))

	require.Equal(t, 2, fx.Count(t, e.pool,
		`SELECT count(*) FROM registrations WHERE status = 'PENDING' AND user_id = $1 AND event_id = $2`, e.user.ID, e.event.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM registrations WHERE id_no_hash = $1 AND id_no_enc IS NOT NULL AND id_no_enc <> convert_to('N01234567', 'UTF8')`,
		fx.PII(t).Hash("N01234567")))
	require.Equal(t, 2, fx.Count(t, e.pool, `SELECT count(*) FROM order_participants WHERE order_id = $1`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND coupon_id = $2 AND state = 'RESERVED' AND discount_cents = 1000`, d.ID, coupon))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM registration_consents rc JOIN disclaimer_signatures ds ON ds.id = rc.signature_id
		 WHERE rc.reg_order_id = $1 AND ds.user_id = $2`, d.ID, e.user.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM runner_profiles WHERE user_id = $1 AND full_name = 'Lim Dara'`, e.user.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'reg_order.create' AND entity_type = 'reg_order' AND entity_id = $1
		 AND actor_type = 'USER' AND actor_id = $2 AND is_financial AND event_id = $3`, d.ID, e.user.ID, e.event.ID))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM idempotency_keys WHERE scope = 'reg_order.create' AND subject = $1 AND key = 'order-key-0001' AND response_code = 201`,
		fmt.Sprintf("user:%d", e.user.ID)))
	require.Equal(t, 0, fx.Count(t, e.pool,
		`SELECT count(*) FROM audit_logs WHERE entity_type = 'reg_order' AND (after_data::text LIKE '%N01234567%' OR after_data::text LIKE '%P7654321%')`),
		"审计里不出现证件号")
}

func TestCreateOrderWithWaiverIsPaidAndConfirmed(t *testing.T) {
	e := newOrderEnv(t, 100)
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "FREE1", DiscountType: "WAIVER", Quota: 2})
	in := e.input("order-key-free", fx.Profile("Keo Nita", "K100200", "KH", "1995-01-01"))
	in.CouponCode = "FREE1"

	d, err := e.svc.CreateOrder(context.Background(), e.user, in, testMeta)

	require.NoError(t, err)
	require.Equal(t, registration.StatusPaid, d.Status)
	require.Equal(t, "CONSUMED", d.ReservationState)
	require.Equal(t, int64(0), d.AmountCents)
	require.Equal(t, int64(0), d.IdentOffsetCents)
	require.Equal(t, int64(2500), d.DiscountCents)
	require.Nil(t, d.DeadlineAt)
	require.NotNil(t, d.PaidAt)
	require.True(t, d.PaidAt.Equal(e.clock.Now()))
	require.Equal(t, registration.RegistrationConfirmed, d.Participants[0].RegistrationStatus)
	require.NotNil(t, d.Participants[0].TicketCode)
	require.Len(t, *d.Participants[0].TicketCode, 32)
	require.Equal(t, int64(0), d.Participants[0].PaidCents)

	require.Equal(t, fx.Counts{Used: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{Used: 1}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{Used: 1}, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'CONSUMED'`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE status = 'CONFIRMED' AND confirmed_at IS NOT NULL`))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.create' AND entity_id = $1`, d.ID))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.paid_zero' AND entity_id = $1 AND is_financial`, d.ID))
}

func TestCreateOrderIdentOffsetsAreDistinctUnderConcurrency(t *testing.T) {
	e := newOrderEnv(t, 100)
	const workers = 10
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make([]registration.OrderDetail, workers)
	errs := make([]error, workers)
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			in := e.input(fmt.Sprintf("ident-key-%04d", i), fx.Profile(fmt.Sprintf("Runner %d", i), fmt.Sprintf("C%07d", i), "US", "1990-01-01"))
			results[i], errs[i] = e.svc.CreateOrder(context.Background(), e.user, in, testMeta)
		}()
	}
	close(start)
	wg.Wait()

	offsets := map[int64]bool{}
	for i := range workers {
		require.NoError(t, errs[i])
		off := results[i].IdentOffsetCents
		require.GreaterOrEqual(t, off, int64(1))
		require.LessOrEqual(t, off, int64(workers))
		require.False(t, offsets[off], "识别分 %d 重复", off)
		offsets[off] = true
		require.Equal(t, 2500-off, results[i].AmountCents)
	}
	require.Equal(t, fx.Counts{Reserved: workers}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
}

func TestCreateOrderLastSeatUnderConcurrency(t *testing.T) {
	e := newOrderEnv(t, 1)
	const workers = 20
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, workers)
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			in := e.input(fmt.Sprintf("seat-key-%04d", i), fx.Profile(fmt.Sprintf("Runner %d", i), fmt.Sprintf("S%07d", i), "KH", "1990-01-01"))
			_, errs[i] = e.svc.CreateOrder(context.Background(), e.user, in, testMeta)
		}()
	}
	close(start)
	wg.Wait()

	success := 0
	for _, err := range errs {
		if err == nil {
			success++
			continue
		}
		requireAppErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	}
	require.Equal(t, 1, success)
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations`))
}

func TestCreateOrderIdempotencyKey(t *testing.T) {
	e := newOrderEnv(t, 100)
	ctx := context.Background()
	in := e.input("replay-key-0001", fx.Profile("Sam Rith", "R123456", "KH", "1990-01-01"))

	first, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	require.NoError(t, err)
	second, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	require.NoError(t, err)

	require.Equal(t, first.OrderNo, second.OrderNo)
	require.Equal(t, first.AmountCents, second.AmountCents)
	require.Equal(t, first.Participants[0].RegNo, second.Participants[0].RegNo)
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
	require.Equal(t, fx.Counts{Reserved: 1}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	changed := in
	changed.CouponCode = "NOPE"
	_, err = e.svc.CreateOrder(ctx, e.user, changed, testMeta)
	requireAppErr(t, err, apperr.CodeIdempotencyKeyReused, http.StatusUnprocessableEntity)

	other := fx.Runner(t, e.pool, 900002, "Other")
	otherIn := e.input("replay-key-0001", fx.Profile("Other Runner", "O123456", "KH", "1990-01-01"))
	otherOrder, err := e.svc.CreateOrder(ctx, other, otherIn, testMeta)
	require.NoError(t, err, "幂等键按跑者隔离")
	require.NotEqual(t, first.OrderNo, otherOrder.OrderNo)

	e.clock.Advance(25 * time.Hour)
	expired := e.input("replay-key-0001", fx.Profile("Sam Rith Junior", "R999999", "KH", "1991-01-01"))
	third, err := e.svc.CreateOrder(ctx, e.user, expired, testMeta)
	require.NoError(t, err, "过期的幂等键不再生效")
	require.NotEqual(t, first.OrderNo, third.OrderNo)
	require.Equal(t, 3, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderRejectsClosedRegistration(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	now := e.clock.Now()
	attempt := func(key string) error {
		_, err := e.svc.CreateOrder(ctx, e.user, e.input(key, fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
		return err
	}

	fx.Exec(t, e.pool, `UPDATE events SET registration_open = false WHERE id = $1`, e.event.ID)
	requireAppErr(t, attempt("closed-key-0001"), apperr.CodeRegistrationClosed, http.StatusConflict)

	fx.Exec(t, e.pool, `UPDATE events SET registration_open = true, registration_closes_at = $2 WHERE id = $1`, e.event.ID, now.Add(-time.Hour))
	requireAppErr(t, attempt("closed-key-0002"), apperr.CodeRegistrationClosed, http.StatusConflict)

	fx.Exec(t, e.pool, `UPDATE events SET registration_closes_at = NULL, registration_opens_at = $2 WHERE id = $1`, e.event.ID, now.Add(time.Hour))
	requireAppErr(t, attempt("closed-key-0003"), apperr.CodeRegistrationClosed, http.StatusConflict)

	in := e.input("closed-key-0004", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"))
	in.EventSlug = "does-not-exist"
	_, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)
	requireAppErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)

	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderRejectsDuplicateIDNumbers(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()

	_, err := e.svc.CreateOrder(ctx, e.user, e.input("dup-key-0001",
		fx.Profile("Chan A", "AB 12-34", "KH", "1990-01-01"),
		fx.Profile("Chan B", "ab1234", "US", "1991-01-01")), testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.duplicate_id_no", ae.Fields["participants[1].idNo"].Key)
	require.NotContains(t, ae.Fields, "participants[0].idNo")

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("dup-key-0002", fx.Profile("Chan A", "AB1234", "KH", "1990-01-01")), testMeta)
	require.NoError(t, err)

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("dup-key-0003",
		fx.Profile("Chan C", "X999999", "KH", "1990-01-01"),
		fx.Profile("Chan A2", "ab-1234", "KH", "1990-01-01")), testMeta)
	ae = requireAppErr(t, err, apperr.CodeAlreadyRegistered, http.StatusConflict)
	require.Equal(t, "field.already_registered", ae.Fields["participants[1].idNo"].Key)
	require.NotContains(t, ae.Fields, "participants[0].idNo")
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderFailureLeavesNoTrace(t *testing.T) {
	e := newOrderEnv(t, 10)
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	in := e.input("rollback-key-0001",
		fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01"),
		fx.Profile("Lim Dara", "P7654321", "US", "1992-08-20"))
	in.CouponCode = "RUN20"
	in.Participants[0].SaveAsProfile = true
	in.Consent.CheckedItems = []string{"rules", "health"}

	_, err := e.svc.CreateOrder(context.Background(), e.user, in, testMeta)

	requireAppErr(t, err, apperr.CodeConsentInvalid, http.StatusUnprocessableEntity)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
	require.Equal(t, fx.Counts{}, e.counts(t, "price_rules", e.rule))
	require.Equal(t, fx.Counts{}, e.counts(t, "coupons", coupon))
	for _, table := range []string{"reg_orders", "order_participants", "registrations", "coupon_redemptions",
		"runner_profiles", "idempotency_keys", "registration_consents", "disclaimer_signatures"} {
		require.Equal(t, 0, fx.Count(t, e.pool, "SELECT count(*) FROM "+table), table)
	}
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action LIKE 'reg_order.%'`))
}

func TestCreateOrderAgeAndPaymentAccountChecks(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()

	_, err := e.svc.CreateOrder(ctx, e.user, e.input("age-key-0001", fx.Profile("Young Runner", "Y1234567", "KH", "2012-01-01")), testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.too_young", ae.Fields["participants[0].birthDate"].Key)

	fx.Exec(t, e.pool, `UPDATE payment_accounts SET active = false`)
	_, err = e.svc.CreateOrder(ctx, e.user, e.input("acct-key-0001", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)
	requireAppErr(t, err, apperr.CodePaymentAccountUnavailable, http.StatusServiceUnavailable)
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
}

func TestCreateOrderPrefersEventAccountOverGlobal(t *testing.T) {
	e := newOrderEnv(t, 10)
	fx.Exec(t, e.pool, `UPDATE payment_accounts SET event_id = NULL WHERE id = $1`, e.account)
	eventAccount := fx.PaymentAccount(t, e.pool, &e.event.ID)

	d, err := e.svc.CreateOrder(context.Background(), e.user,
		e.input("acct-key-0002", fx.Profile("Chan Sophea", "N01234567", "KH", "1990-05-01")), testMeta)

	require.NoError(t, err)
	require.Equal(t, eventAccount, d.PaymentAccountID)
}

func TestCreateOrderWithSavedProfile(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	saved, err := e.runners.CreateProfile(ctx, e.user, fx.Profile("Saved Runner", "S7777777", "KH", "1985-03-03"), true)
	require.NoError(t, err)
	in := registration.CreateOrderInput{
		EventSlug:      e.event.Slug,
		Consent:        e.consent,
		IdempotencyKey: "saved-key-0001",
		Participants:   []registration.OrderParticipantInput{{CategoryID: e.event.CategoryIDs[0], ProfileID: &saved.ID}},
	}

	d, err := e.svc.CreateOrder(ctx, e.user, in, testMeta)

	require.NoError(t, err)
	require.Equal(t, "Saved Runner", d.Participants[0].FullName)
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE id_no_hash = $1`, fx.PII(t).Hash("S7777777")))

	other := fx.Runner(t, e.pool, 900003, "Stranger")
	in.IdempotencyKey = "saved-key-0002"
	_, err = e.svc.CreateOrder(ctx, other, in, testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Contains(t, ae.Fields, "participants[0].profileId")
}

func TestCreateOrderParticipantCountLimits(t *testing.T) {
	e := newOrderEnv(t, 100)
	ctx := context.Background()
	profiles := func(prefix string, n int) []runner.ProfileData {
		out := make([]runner.ProfileData, n)
		for i := range out {
			out[i] = fx.Profile(fmt.Sprintf("Runner %s%d", prefix, i), fmt.Sprintf("%s%07d", prefix, i), "KH", "1990-01-01")
		}
		return out
	}

	_, err := e.svc.CreateOrder(ctx, e.user, e.input("count-key-0000"), testMeta)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["participants"].Key, "0 人")

	_, err = e.svc.CreateOrder(ctx, e.user, e.input("count-key-0011", profiles("E", 11)...), testMeta)
	ae = requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["participants"].Key, "11 人")
	require.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`))
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	d, err := e.svc.CreateOrder(ctx, e.user, e.input("count-key-0010", profiles("T", 10)...), testMeta)
	require.NoError(t, err, "10 人是上限，允许")
	require.Len(t, d.Participants, 10)
	require.Equal(t, fx.Counts{Reserved: 10}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))
}

func TestConfirmPaidConsumesOnlyOnce(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	coupon := fx.Coupon(t, e.pool, fx.CouponOpts{Code: "RUN20", EventID: &e.event.ID, DiscountType: "PERCENT", DiscountValue: 20, Quota: 5})
	firstIn := e.input("confirm-key-0001", fx.Profile("First Runner", "F1234567", "KH", "1990-01-01"))
	firstIn.CouponCode = "RUN20"
	first, err := e.svc.CreateOrder(ctx, e.user, firstIn, testMeta)
	require.NoError(t, err)
	secondIn := e.input("confirm-key-0002", fx.Profile("Second Runner", "G1234567", "KH", "1990-01-01"))
	secondIn.CouponCode = "RUN20"
	second, err := e.svc.CreateOrder(ctx, e.user, secondIn, testMeta)
	require.NoError(t, err, "第二张订单在同一组别、价格档、优惠码上持有预留")

	category, rule := e.event.CategoryIDs[0], e.rule
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "event_categories", category))
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "price_rules", rule))
	require.Equal(t, fx.Counts{Reserved: 2}, e.counts(t, "coupons", coupon))

	fx.Exec(t, e.pool, `UPDATE reg_orders SET status = 'PROOF_SUBMITTED', deadline_at = NULL WHERE id = $1`, first.ID)
	paidAt := e.clock.Now()
	require.NoError(t, db.InTx(ctx, e.pool, func(tx pgx.Tx) error {
		return e.svc.ConfirmPaid(ctx, tx, first.ID, paidAt)
	}))
	afterFirst := fx.Counts{Used: 1, Reserved: 1}
	require.Equal(t, afterFirst, e.counts(t, "event_categories", category))
	require.Equal(t, afterFirst, e.counts(t, "price_rules", rule))
	require.Equal(t, afterFirst, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PAID' AND reservation_state = 'CONSUMED' AND paid_at IS NOT NULL AND deadline_at IS NULL`, first.ID))

	// 第二次调用拿到冲突后仍然提交事务：若计数在冲突判断之前被改动，提交后就会暴露出来。
	var again, notPayable error
	require.NoError(t, db.InTx(ctx, e.pool, func(tx pgx.Tx) error {
		again = e.svc.ConfirmPaid(ctx, tx, first.ID, paidAt)
		notPayable = e.svc.ConfirmPaid(ctx, tx, second.ID, paidAt)
		return nil
	}))
	requireAppErr(t, again, apperr.CodeOrderStateConflict, http.StatusConflict)
	requireAppErr(t, notPayable, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, afterFirst, e.counts(t, "event_categories", category))
	require.Equal(t, afterFirst, e.counts(t, "price_rules", rule))
	require.Equal(t, afterFirst, e.counts(t, "coupons", coupon))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE status = 'CONFIRMED'`))
	require.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM coupon_redemptions WHERE state = 'CONSUMED'`))
	require.Equal(t, 1, fx.Count(t, e.pool,
		`SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PENDING_PAYMENT' AND reservation_state = 'RESERVED'`, second.ID))
}

func TestPreviewQuote(t *testing.T) {
	e := newOrderEnv(t, 10)
	ctx := context.Background()
	in := registration.QuotePreviewInput{Participants: []pricing.ParticipantInput{
		{CategoryID: e.event.CategoryIDs[0], Nationality: "KH", BirthDate: fx.Day("1990-01-01")},
	}}

	q, err := e.svc.PreviewQuote(ctx, e.user, e.event.Slug, in)

	require.NoError(t, err)
	require.Equal(t, int64(2500), q.AmountCents)
	require.Equal(t, int64(0), q.IdentOffsetCents)
	require.Equal(t, fx.Counts{}, e.counts(t, "event_categories", e.event.CategoryIDs[0]))

	_, err = e.svc.PreviewQuote(ctx, e.user, "does-not-exist", in)
	requireAppErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)

	_, err = e.svc.PreviewQuote(ctx, e.user, e.event.Slug, registration.QuotePreviewInput{})
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["participants"].Key)

	repeat := func(n int) registration.QuotePreviewInput {
		out := registration.QuotePreviewInput{}
		for range n {
			out.Participants = append(out.Participants, in.Participants[0])
		}
		return out
	}
	_, err = e.svc.PreviewQuote(ctx, e.user, e.event.Slug, repeat(11))
	ae = requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["participants"].Key, "11 人")
	ten, err := e.svc.PreviewQuote(ctx, e.user, e.event.Slug, repeat(10))
	require.NoError(t, err, "10 人是上限，允许")
	require.Equal(t, int64(25000), ten.AmountCents)

	fx.Exec(t, e.pool, `UPDATE events SET status = 'DRAFT' WHERE id = $1`, e.event.ID)
	_, err = e.svc.PreviewQuote(ctx, e.user, e.event.Slug, in)
	requireAppErr(t, err, apperr.CodeEventNotFound, http.StatusNotFound)
}
