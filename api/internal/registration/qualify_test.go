package registration_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
	fx "werun/api/internal/testfixture"
)

type eliteEnv struct {
	orderEnv
	elite, open int64
	ops         iam.Staff
}

// newEliteEnv：21KE 精英组（1:45 以内，容量 eliteCap）不通过转到 21K 公开组（容量 openCap），两组同价 $25；
// 另有一个 WAIVER 码 FREE 让订单直接确认。
func newEliteEnv(t *testing.T, eliteCap, openCap int32) eliteEnv {
	t.Helper()
	pool := dbtest.NewPool(t)
	clock := &fakeClock{now: time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)}
	runners := fx.RunnerService(t, pool, clock.Now)
	prices := pricing.NewService(pool, clock.Now)
	ev := fx.RaceEvent(t, pool, fx.EventOpts{Slug: "elite-run", RegistrationOpen: true,
		Categories: []fx.CategoryOpts{{Code: "21KE", Capacity: eliteCap}, {Code: "21K", Capacity: openCap}}})
	e := eliteEnv{
		orderEnv: orderEnv{
			pool:    pool,
			clock:   clock,
			runners: runners,
			svc:     registration.NewService(pool, runners, prices, notifytest.New(t, pool), clock.Now),
			event:   ev,
			rule:    fx.PriceRule(t, pool, ev.ID, fx.PriceRuleOpts{PriceCents: 2500, CategoryIDs: ev.CategoryIDs}),
			account: fx.PaymentAccount(t, pool, &ev.ID),
			consent: fx.RegistrationConsent(t, runners),
		},
		elite: ev.CategoryIDs[0],
		open:  ev.CategoryIDs[1],
	}
	fx.Coupon(t, pool, fx.CouponOpts{Code: "FREE", EventID: &ev.ID, DiscountType: "WAIVER", Quota: 20})
	fx.Exec(t, pool, `UPDATE event_categories
		SET qualify_required = true, qualify_rule = '{"zh":"1:45 以内","en":"Under 1:45","km":"ក្រោម 1:45"}',
		    qualify_max_ms = 6300000, fallback_category_id = $2
		WHERE id = $1`, e.elite, e.open)
	svc := iam.NewService(pool, []byte("ssssssssssssssssssssssssssssssss"), iam.NewLoginLimiter(time.Now), time.Now)
	ops, err := svc.CreateStaff(context.Background(), "ops.elite", "Ops", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	e.ops = ops
	return e
}

func (e eliteEnv) order(t *testing.T, telegramID int64, idNo, coupon string, q *registration.QualificationInput) (registration.OrderDetail, error) {
	t.Helper()
	u := fx.Runner(t, e.pool, telegramID, "Elite")
	p := fx.Profile("Elite Runner "+idNo, idNo, "US", "1990-01-01")
	return e.svc.CreateOrder(context.Background(), u, registration.CreateOrderInput{
		EventSlug:      e.event.Slug,
		CouponCode:     coupon,
		Consent:        e.consent,
		Participants:   []registration.OrderParticipantInput{{CategoryID: e.elite, Profile: &p, Qualification: q}},
		IdempotencyKey: "elite-" + idNo,
	}, httpx.Meta{})
}

func proof(ms int32) *registration.QualificationInput {
	return &registration.QualificationInput{BestTimeMs: ms, Source: " Mekong Night Run 2025 ", ProofURL: "https://results.example.kh/123"}
}

func proofIDOf(t *testing.T, e eliteEnv, regNo string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`SELECT qp.id FROM qualification_proofs qp JOIN registrations r ON r.id = qp.registration_id WHERE r.reg_no = $1`, regNo).Scan(&id))
	return id
}

func TestEliteOrderRequiresProof(t *testing.T) {
	e := newEliteEnv(t, 10, 100)

	_, err := e.order(t, 910001, "ELITE0001", "FREE", nil)
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	assert.Equal(t, "field.required", ae.Fields["participants[0].bestTimeMs"].Key)

	_, err = e.order(t, 910011, "ELITE0001", "FREE", proof(6300001))
	ae = requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	assert.Equal(t, "field.qualify_too_slow", ae.Fields["participants[0].bestTimeMs"].Key)
	assert.Equal(t, "1:45:00", ae.Fields["participants[0].bestTimeMs"].Params["max"])

	bad := proof(6000000)
	bad.ProofURL = "results.example.kh"
	bad.Source = ""
	_, err = e.order(t, 910012, "ELITE0001", "FREE", bad)
	ae = requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	assert.Equal(t, "field.url_format", ae.Fields["participants[0].proofUrl"].Key)
	assert.Equal(t, "field.required", ae.Fields["participants[0].proofSource"].Key)
	assert.Equal(t, 0, fx.Count(t, e.pool, `SELECT count(*) FROM reg_orders`), "校验失败不留订单")

	d, err := e.order(t, 910013, "ELITE0001", "FREE", proof(6000000))
	require.NoError(t, err)
	require.Equal(t, registration.StatusPaid, d.Status)
	require.NotNil(t, d.Participants[0].Qualification)
	assert.Equal(t, registration.QualifyPending, d.Participants[0].Qualification.Status)
	assert.Equal(t, "21KE run", d.Participants[0].Qualification.AppliedCategoryName["en"])
	var source string
	require.NoError(t, e.pool.QueryRow(context.Background(), `SELECT source FROM qualification_proofs`).Scan(&source))
	assert.Equal(t, "Mekong Night Run 2025", source, "来源去掉首尾空白")

	// 普通组带了证明也不保存
	u := fx.Runner(t, e.pool, 910099, "Open")
	p := fx.Profile("Open Runner", "OPEN0001", "US", "1990-01-01")
	_, err = e.svc.CreateOrder(context.Background(), u, registration.CreateOrderInput{
		EventSlug: e.event.Slug, CouponCode: "FREE", Consent: e.consent, IdempotencyKey: "open-0001",
		Participants: []registration.OrderParticipantInput{{CategoryID: e.open, Profile: &p, Qualification: proof(6000000)}},
	}, httpx.Meta{})
	require.NoError(t, err)
	assert.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM qualification_proofs`))
}

func TestReviewQualificationProof(t *testing.T) {
	e := newEliteEnv(t, 10, 2)
	ctx := context.Background()

	// 待付款的报名不能核验
	pending, err := e.order(t, 920001, "ELITE1001", "", proof(6000000))
	require.NoError(t, err)
	_, err = e.svc.RejectQualificationProof(ctx, e.ops, proofIDOf(t, e, pending.Participants[0].RegNo), "")
	requireAppErr(t, err, apperr.CodeQualifyNotConfirmed, http.StatusConflict)

	// 不通过：转到公开组，已确认名额从精英组搬到公开组
	paid, err := e.order(t, 920002, "ELITE1002", "FREE", proof(6000000))
	require.NoError(t, err)
	id := proofIDOf(t, e, paid.Participants[0].RegNo)
	before := e.counts(t, "event_categories", e.elite)
	rejected, err := e.svc.RejectQualificationProof(ctx, e.ops, id, "  成绩页查不到  ")
	require.NoError(t, err)
	assert.Equal(t, registration.QualifyRejected, rejected.Status)
	assert.Equal(t, "21K", *rejected.MovedToCategoryCode)
	assert.Equal(t, "成绩页查不到", *rejected.ReviewNote)
	assert.Equal(t, before.Used-1, e.counts(t, "event_categories", e.elite).Used)
	assert.Equal(t, int32(1), e.counts(t, "event_categories", e.open).Used)
	assert.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM registrations WHERE reg_no = $1 AND category_id = $2`,
		paid.Participants[0].RegNo, e.open))
	assert.Equal(t, 2, fx.Count(t, e.pool, `SELECT count(*) FROM order_participants WHERE category_id = $1`, e.elite),
		"财务快照不动：两张订单的参赛人快照都还记在精英组")
	assert.Equal(t, 1, fx.Count(t, e.pool, `SELECT count(*) FROM audit_logs WHERE action = 'qualification.reject'`))

	detail, err := e.svc.GetMyOrder(ctx, runner.User{ID: paid.BuyerUserID}, paid.OrderNo)
	require.NoError(t, err)
	assert.Equal(t, e.open, detail.Participants[0].CategoryID, "订单页显示当前所在组")
	assert.Equal(t, registration.QualifyRejected, detail.Participants[0].Qualification.Status)

	_, err = e.svc.ApproveQualificationProof(ctx, e.ops, id)
	requireAppErr(t, err, apperr.CodeQualifyReviewed, http.StatusConflict)

	// 已分配号码布不能转组，但可以通过
	withBib, err := e.order(t, 920003, "ELITE1003", "FREE", proof(5000000))
	require.NoError(t, err)
	bibID := proofIDOf(t, e, withBib.Participants[0].RegNo)
	fx.Exec(t, e.pool, `INSERT INTO bib_assignments (event_id, bib_number, registration_id, status, assign_method)
		SELECT event_id, 1, id, 'ASSIGNED', 'MANUAL' FROM registrations WHERE reg_no = $1`, withBib.Participants[0].RegNo)
	_, err = e.svc.RejectQualificationProof(ctx, e.ops, bibID, "")
	requireAppErr(t, err, apperr.CodeQualifyBibAssigned, http.StatusConflict)
	approved, err := e.svc.ApproveQualificationProof(ctx, e.ops, bibID)
	require.NoError(t, err)
	assert.Equal(t, registration.QualifyApproved, approved.Status)
	assert.Nil(t, approved.MovedToCategoryCode)

	// 公开组满了不能转组，什么都不改
	full, err := e.order(t, 920004, "ELITE1004", "FREE", proof(5000000))
	require.NoError(t, err)
	fx.Exec(t, e.pool, `UPDATE event_categories SET capacity = used_count + reserved_count WHERE id = $1`, e.open)
	eliteBefore := e.counts(t, "event_categories", e.elite)
	_, err = e.svc.RejectQualificationProof(ctx, e.ops, proofIDOf(t, e, full.Participants[0].RegNo), "")
	requireAppErr(t, err, apperr.CodeQualifyFallbackFull, http.StatusConflict)
	assert.Equal(t, eliteBefore, e.counts(t, "event_categories", e.elite))

	list, err := e.svc.ListQualificationProofs(ctx, e.event.ID)
	require.NoError(t, err)
	require.Len(t, list, 4)
	assert.Equal(t, registration.QualifyPending, list[0].Status, "待核验在前")
	assert.Equal(t, registration.QualifyPending, list[1].Status)
	assert.Equal(t, "21K", *list[0].FallbackCategoryCode)
}
