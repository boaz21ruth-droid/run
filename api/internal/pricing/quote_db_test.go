package pricing_test

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/pricing"
	fx "werun/api/internal/testfixture"
)

var quoteNow = *at("2026-09-14T03:00:00Z")

func newPricing(t *testing.T) (*pgxpool.Pool, *pricing.Service) {
	t.Helper()
	pool := dbtest.NewPool(t)
	return pool, pricing.NewService(pool, func() time.Time { return quoteNow })
}

func quoteInTx(t *testing.T, pool *pgxpool.Pool, svc *pricing.Service, in pricing.QuoteInput) (pricing.Quote, error) {
	t.Helper()
	var out pricing.Quote
	err := db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		q, err := svc.Quote(context.Background(), tx, in)
		out = q
		return err
	})
	return out, err
}

func runTx(pool *pgxpool.Pool, fn func(ctx context.Context, tx pgx.Tx) error) error {
	ctx := context.Background()
	return db.InTx(ctx, pool, func(tx pgx.Tx) error { return fn(ctx, tx) })
}

func requireAppErr(t *testing.T, err error, code string, status int) *apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return ae
}

func TestQuoteSelectsTiersAppliesCouponAndIdentOffset(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "quote-run", RegistrationOpen: true,
		Categories: []fx.CategoryOpts{{Code: "21K", Capacity: 100, MinAge: 16}}})
	cat := ev.CategoryIDs[0]
	local := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{Audience: "LOCAL", PriceCents: 1800, CategoryIDs: []int64{cat}})
	early := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2000, Quota: fx.Ptr[int32](1),
		SaleEndsAt: at("2026-10-01T00:00:00Z"), CategoryIDs: []int64{cat}})
	standard := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 3000, CategoryIDs: []int64{cat}})
	couponID := fx.Coupon(t, pool, fx.CouponOpts{Code: "RUN10", EventID: &ev.ID, DiscountType: "PERCENT", DiscountValue: 10, Quota: 5})
	account := fx.PaymentAccount(t, pool, nil)
	fx.Order(t, pool, fx.OrderOpts{EventID: ev.ID, PaymentAccountID: &account, Status: "PENDING_PAYMENT", AmountCents: 6119})
	fx.Order(t, pool, fx.OrderOpts{EventID: ev.ID, PaymentAccountID: &account, Status: "PAID", AmountCents: 6118})

	in := pricing.QuoteInput{
		EventID:    ev.ID,
		RaceDate:   ev.RaceDate,
		CouponCode: " run10 ",
		Participants: []pricing.ParticipantInput{
			{CategoryID: cat, Nationality: "KH", BirthDate: day("1990-05-01")},
			{CategoryID: cat, Nationality: "US", BirthDate: day("1988-01-01")},
			{CategoryID: cat, Nationality: "us", BirthDate: day("1995-12-31")},
		},
		Now:              quoteNow,
		PaymentAccountID: &account,
	}

	q, err := quoteInTx(t, pool, svc, in)

	require.NoError(t, err)
	require.Equal(t, []pricing.ParticipantQuote{
		{CategoryID: cat, PriceRuleID: local, Audience: "LOCAL", ListPriceCents: 1800, PaidCents: 1620},
		{CategoryID: cat, PriceRuleID: early, Audience: "ALL", ListPriceCents: 2000, PaidCents: 1799},
		{CategoryID: cat, PriceRuleID: standard, Audience: "ALL", ListPriceCents: 3000, PaidCents: 2699},
	}, q.Participants)
	require.Equal(t, int64(6800), q.ListAmountCents)
	require.Equal(t, &couponID, q.CouponID)
	require.Equal(t, int64(680), q.CouponDiscountCents)
	require.Equal(t, int64(2), q.IdentOffsetCents, "6119 被待付款订单占用，6118 属于已付款订单不算占用")
	require.Equal(t, int64(682), q.DiscountCents)
	require.Equal(t, int64(6118), q.AmountCents)
	require.Equal(t, "USD", q.Currency)
	require.Equal(t, fx.Counts{}, fx.CountersOf(t, pool, "price_rules", early), "算价不改计数")

	in.PaymentAccountID = nil
	preview, err := quoteInTx(t, pool, svc, in)
	require.NoError(t, err)
	require.Equal(t, int64(0), preview.IdentOffsetCents)
	require.Equal(t, int64(6120), preview.AmountCents)
	require.Equal(t, []int64{1620, 1800, 2700},
		[]int64{preview.Participants[0].PaidCents, preview.Participants[1].PaidCents, preview.Participants[2].PaidCents})
}

func TestQuoteIdentOffsetHonoursSettingMax(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "ident-max", Categories: []fx.CategoryOpts{{Code: "10K", Capacity: 10}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs})
	account := fx.PaymentAccount(t, pool, &ev.ID)
	fx.Order(t, pool, fx.OrderOpts{EventID: ev.ID, PaymentAccountID: &account, Status: "PROOF_REJECTED", AmountCents: 2499})
	fx.SetSetting(t, pool, "payment.ident_offset_max_cents", "1")

	q, err := quoteInTx(t, pool, svc, pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, Now: quoteNow, PaymentAccountID: &account,
		Participants: []pricing.ParticipantInput{{CategoryID: ev.CategoryIDs[0], Nationality: "US", BirthDate: day("1990-01-01")}}})

	require.NoError(t, err)
	require.Equal(t, int64(0), q.IdentOffsetCents)
	require.Equal(t, int64(2500), q.AmountCents)
}

func TestQuoteReportsAgeAndCategoryFieldErrors(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "age-run", Categories: []fx.CategoryOpts{
		{Code: "21K", Capacity: 100, MinAge: 16},
		{Code: "5K", Capacity: 100},
	}})
	other := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "other-run", Categories: []fx.CategoryOpts{{Code: "10K", Capacity: 100}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: []int64{ev.CategoryIDs[0]}})
	fx.PriceRule(t, pool, other.ID, fx.PriceRuleOpts{PriceCents: 1000, CategoryIDs: other.CategoryIDs})

	_, err := quoteInTx(t, pool, svc, pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, Now: quoteNow,
		Participants: []pricing.ParticipantInput{
			{CategoryID: ev.CategoryIDs[0], Nationality: "KH", BirthDate: day("2012-01-01")},
			{CategoryID: other.CategoryIDs[0], Nationality: "KH", BirthDate: day("1990-01-01")},
			{CategoryID: ev.CategoryIDs[1], Nationality: "KH", BirthDate: day("1990-01-01")},
		}})

	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, apperr.FieldError{Key: "field.too_young", Params: map[string]any{"minAge": 16}}, ae.Fields["participants[0].birthDate"])
	require.Equal(t, "field.category_unavailable", ae.Fields["participants[1].categoryId"].Key, "别的赛事的组别")
	require.Equal(t, "field.category_unavailable", ae.Fields["participants[2].categoryId"].Key, "没有关联价格档的组别")
}

func TestQuoteCouponRules(t *testing.T) {
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "coupon-run", Categories: []fx.CategoryOpts{{Code: "21K", Capacity: 100}}})
	other := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "coupon-other", Categories: []fx.CategoryOpts{{Code: "10K", Capacity: 100}}})
	fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "OTHER1", EventID: &other.ID, DiscountType: "PERCENT", DiscountValue: 10, Quota: 5})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "OFF1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, Status: "DISABLED"})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "OLD1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, ValidUntil: at("2026-09-01T00:00:00Z")})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "SOON1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, ValidFrom: at("2026-10-01T00:00:00Z")})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "TRIO1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 5, MinRunners: fx.Ptr[int16](3)})
	fx.Coupon(t, pool, fx.CouponOpts{Code: "USED1", DiscountType: "PERCENT", DiscountValue: 10, Quota: 1})
	fx.Exec(t, pool, `UPDATE coupons SET reserved_count = 1 WHERE code = 'USED1'`)
	global := fx.Coupon(t, pool, fx.CouponOpts{Code: "GLOBAL1", DiscountType: "AMOUNT", DiscountValue: 700, Quota: 5,
		ValidFrom: at("2026-09-01T00:00:00Z"), ValidUntil: at("2026-09-30T00:00:00Z")})

	in := func(code string) pricing.QuoteInput {
		return pricing.QuoteInput{EventID: ev.ID, RaceDate: ev.RaceDate, Now: quoteNow, CouponCode: code,
			Participants: []pricing.ParticipantInput{
				{CategoryID: ev.CategoryIDs[0], Nationality: "US", BirthDate: day("1990-01-01")},
				{CategoryID: ev.CategoryIDs[0], Nationality: "US", BirthDate: day("1991-01-01")},
			}}
	}

	for _, code := range []string{"NOPE", "other1", "OFF1", "OLD1", "SOON1", "TRIO1"} {
		t.Run("不可用 "+code, func(t *testing.T) {
			_, err := quoteInTx(t, pool, svc, in(code))
			ae := requireAppErr(t, err, apperr.CodeCouponInvalid, http.StatusUnprocessableEntity)
			require.Equal(t, "field.coupon_invalid", ae.Fields["couponCode"].Key)
		})
	}
	t.Run("次数用完", func(t *testing.T) {
		_, err := quoteInTx(t, pool, svc, in("used1"))
		_ = requireAppErr(t, err, apperr.CodeCouponExhausted, http.StatusConflict)
	})
	t.Run("全场通用固定金额码", func(t *testing.T) {
		q, err := quoteInTx(t, pool, svc, in("global1"))
		require.NoError(t, err)
		require.Equal(t, &global, q.CouponID)
		require.Equal(t, int64(700), q.CouponDiscountCents)
		require.Equal(t, int64(4300), q.AmountCents)
		require.Equal(t, int64(2150), q.Participants[0].PaidCents)
		require.Equal(t, int64(2150), q.Participants[1].PaidCents)
	})
}

type counterFixture struct {
	pool   *pgxpool.Pool
	svc    *pricing.Service
	ev     fx.Event
	rule   int64
	coupon int64
}

func newCounterFixture(t *testing.T, capacity int32, ruleQuota *int32, couponQuota int32) counterFixture {
	t.Helper()
	pool, svc := newPricing(t)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "counter-run", Categories: []fx.CategoryOpts{{Code: "21K", Capacity: capacity}}})
	rule := fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, Quota: ruleQuota, CategoryIDs: ev.CategoryIDs})
	coupon := fx.Coupon(t, pool, fx.CouponOpts{Code: "RUN20", EventID: &ev.ID, DiscountType: "PERCENT", DiscountValue: 20, Quota: couponQuota})
	return counterFixture{pool: pool, svc: svc, ev: ev, rule: rule, coupon: coupon}
}

func (f counterFixture) quote(n int, withCoupon bool) pricing.Quote {
	q := pricing.Quote{Currency: "USD"}
	for range n {
		q.Participants = append(q.Participants, pricing.ParticipantQuote{
			CategoryID: f.ev.CategoryIDs[0], PriceRuleID: f.rule, Audience: "ALL", ListPriceCents: 2500, PaidCents: 2000})
		q.ListAmountCents += 2500
	}
	if withCoupon {
		id := f.coupon
		q.CouponID = &id
		q.CouponDiscountCents = q.ListAmountCents / 5
	}
	q.DiscountCents = q.CouponDiscountCents
	q.AmountCents = q.ListAmountCents - q.DiscountCents
	return q
}

func (f counterFixture) order(t *testing.T, q pricing.Quote) int64 {
	t.Helper()
	opts := fx.OrderOpts{EventID: f.ev.ID, AmountCents: q.AmountCents}
	for _, p := range q.Participants {
		opts.Participants = append(opts.Participants, fx.OrderParticipantOpts{
			CategoryID: p.CategoryID, PriceRuleID: p.PriceRuleID, ListPriceCents: p.ListPriceCents, PaidCents: p.PaidCents})
	}
	return fx.Order(t, f.pool, opts)
}

func (f counterFixture) requireCounts(t *testing.T, cat, rule, coupon fx.Counts) {
	t.Helper()
	require.Equal(t, cat, fx.CountersOf(t, f.pool, "event_categories", f.ev.CategoryIDs[0]), "组别计数")
	require.Equal(t, rule, fx.CountersOf(t, f.pool, "price_rules", f.rule), "价格档计数")
	require.Equal(t, coupon, fx.CountersOf(t, f.pool, "coupons", f.coupon), "优惠码计数")
}

func TestReserveConsumeAndReleaseMoveCounters(t *testing.T) {
	f := newCounterFixture(t, 10, fx.Ptr[int32](5), 3)
	q := f.quote(2, true)

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, q) }))
	f.requireCounts(t, fx.Counts{Reserved: 2}, fx.Counts{Reserved: 2}, fx.Counts{Reserved: 1})

	orderA := f.order(t, q)
	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.RecordRedemption(ctx, tx, orderA, q) }))
	require.Equal(t, 1, fx.Count(t, f.pool,
		`SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND coupon_id = $2 AND state = 'RESERVED' AND discount_cents = 1000`, orderA, f.coupon))

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Consume(ctx, tx, orderA) }))
	f.requireCounts(t, fx.Counts{Used: 2}, fx.Counts{Used: 2}, fx.Counts{Used: 1})
	require.Equal(t, 1, fx.Count(t, f.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'CONSUMED'`, orderA))

	q2 := f.quote(1, true)
	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, q2) }))
	orderB := f.order(t, q2)
	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.RecordRedemption(ctx, tx, orderB, q2) }))
	f.requireCounts(t, fx.Counts{Used: 2, Reserved: 1}, fx.Counts{Used: 2, Reserved: 1}, fx.Counts{Used: 1, Reserved: 1})

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Release(ctx, tx, orderB) }))
	f.requireCounts(t, fx.Counts{Used: 2}, fx.Counts{Used: 2}, fx.Counts{Used: 1})
	require.Equal(t, 1, fx.Count(t, f.pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RELEASED'`, orderB))

	err := runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Release(ctx, tx, orderB) })
	require.Error(t, err, "预留已经释放过，再释放不能把计数减成负数")
	f.requireCounts(t, fx.Counts{Used: 2}, fx.Counts{Used: 2}, fx.Counts{Used: 1})
}

func TestRecordRedemptionWithoutCouponDoesNothing(t *testing.T) {
	f := newCounterFixture(t, 10, nil, 3)
	q := f.quote(1, false)
	orderID := f.order(t, q)

	require.NoError(t, runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.RecordRedemption(ctx, tx, orderID, q) }))

	require.Equal(t, 0, fx.Count(t, f.pool, `SELECT count(*) FROM coupon_redemptions`))
}

func TestReserveSoldOutErrorsRollBackAllCounters(t *testing.T) {
	f := newCounterFixture(t, 1, fx.Ptr[int32](1), 1)

	fx.Exec(t, f.pool, `UPDATE event_categories SET reserved_count = 1 WHERE id = $1`, f.ev.CategoryIDs[0])
	err := runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, f.quote(1, true)) })
	_ = requireAppErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	f.requireCounts(t, fx.Counts{Reserved: 1}, fx.Counts{}, fx.Counts{})

	fx.Exec(t, f.pool, `UPDATE event_categories SET reserved_count = 0 WHERE id = $1`, f.ev.CategoryIDs[0])
	fx.Exec(t, f.pool, `UPDATE price_rules SET used_count = 1 WHERE id = $1`, f.rule)
	err = runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, f.quote(1, true)) })
	_ = requireAppErr(t, err, apperr.CodePriceTierSoldOut, http.StatusConflict)
	f.requireCounts(t, fx.Counts{}, fx.Counts{Used: 1}, fx.Counts{})

	fx.Exec(t, f.pool, `UPDATE price_rules SET used_count = 0 WHERE id = $1`, f.rule)
	fx.Exec(t, f.pool, `UPDATE coupons SET used_count = 1 WHERE id = $1`, f.coupon)
	err = runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, f.quote(1, true)) })
	_ = requireAppErr(t, err, apperr.CodeCouponExhausted, http.StatusConflict)
	f.requireCounts(t, fx.Counts{}, fx.Counts{}, fx.Counts{Used: 1})
}

func TestReserveLastSeatConcurrently(t *testing.T) {
	f := newCounterFixture(t, 1, nil, 1)
	q := f.quote(1, false)

	const workers = 20
	var (
		wg      sync.WaitGroup
		success atomic.Int32
		mu      sync.Mutex
		errs    []error
	)
	start := make(chan struct{})
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			err := runTx(f.pool, func(ctx context.Context, tx pgx.Tx) error { return f.svc.Reserve(ctx, tx, q) })
			if err == nil {
				success.Add(1)
				return
			}
			mu.Lock()
			errs = append(errs, err)
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()

	require.EqualValues(t, 1, success.Load())
	require.Len(t, errs, workers-1)
	for _, err := range errs {
		_ = requireAppErr(t, err, apperr.CodeCategorySoldOut, http.StatusConflict)
	}
	f.requireCounts(t, fx.Counts{Reserved: 1}, fx.Counts{Reserved: 1}, fx.Counts{})
}
