package racepack_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/racepack"
	"werun/api/internal/testfixture"
)

type fixture struct {
	pool  *pgxpool.Pool
	svc   *racepack.Service
	event testfixture.Event
	rule  int64
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	pool := dbtest.NewPool(t)
	ev := testfixture.RaceEvent(t, pool, testfixture.EventOpts{
		Slug:       "kit-" + uuid.NewString()[:8],
		Categories: []testfixture.CategoryOpts{{Code: "21K", Capacity: 100}},
	})
	rule := testfixture.PriceRule(t, pool, ev.ID, testfixture.PriceRuleOpts{PriceCents: 1900, CategoryIDs: ev.CategoryIDs})
	return fixture{pool: pool, svc: racepack.NewService(pool, time.Now), event: ev, rule: rule}
}

// registration 写一张单人订单与报名。status：CONFIRMED（已付）/ PENDING（待付）/ CANCELLED。
func (f fixture) registration(t *testing.T, name, phone, status, audience string) int64 {
	t.Helper()
	orderStatus := map[string]string{"CONFIRMED": "PAID", "PENDING": "PENDING_PAYMENT", "CANCELLED": "CANCELLED"}[status]
	orderID := testfixture.Order(t, f.pool, testfixture.OrderOpts{EventID: f.event.ID, Status: orderStatus, AmountCents: 1900})
	var participantID int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `
		INSERT INTO order_participants (order_id, category_id, price_rule_id, audience, list_price_cents, paid_cents, snapshot_name)
		VALUES ($1, $2, $3, $4, 1900, 1900, $5) RETURNING id`,
		orderID, f.event.CategoryIDs[0], f.rule, audience, name).Scan(&participantID))
	var cancel *string
	if status == "CANCELLED" {
		cancel = testfixture.Ptr("ORDER_CANCELLED")
	}
	var id int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `
		INSERT INTO registrations (reg_no, order_participant_id, event_id, category_id, status, cancel_reason, ticket_code,
		                           full_name, gender, birth_date, nationality, phone_e164, tshirt_size)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'F', DATE '1994-03-12', 'KH', $9, 'M') RETURNING id`,
		idgen.Code(idgen.PrefixRegistration), participantID, f.event.ID, f.event.CategoryIDs[0], status, cancel,
		idgen.TicketCode(), name, phone).Scan(&id))
	return id
}

func (f fixture) staff(t *testing.T, role iam.Role) iam.Staff {
	t.Helper()
	username := "kit-" + uuid.NewString()[:8]
	var id int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `
		INSERT INTO staff (username, full_name, role, password_hash) VALUES ($1, $2, $3, 'x') RETURNING id`,
		username, "Staff "+string(role), string(role)).Scan(&id))
	return iam.Staff{ID: id, Username: username, FullName: "Staff " + string(role), Role: role}
}

func (f fixture) assign(t *testing.T, staffID int64, from, until time.Time, enabled bool) {
	t.Helper()
	testfixture.Exec(t, f.pool, `INSERT INTO staff_event_assignments (staff_id, event_id, valid_from, valid_until, enabled)
		VALUES ($1, $2, $3, $4, $5)`, staffID, f.event.ID, from, until, enabled)
}

func issue(proxy *string, verified bool) racepack.IssueInput {
	return racepack.IssueInput{ClientEventID: uuid.New(), DeviceID: "phone-1", ProxyName: proxy, IDVerified: verified}
}

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	return ae.Code
}

func TestRaceStaffNeedsActiveAssignment(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	reg := f.registration(t, "Sok Dara", "+85512345678", "CONFIRMED", "ALL")
	now := time.Now()

	unassigned := f.staff(t, iam.RoleRaceStaff)
	_, err := f.svc.Station(ctx, unassigned, f.event.ID, "")
	require.Equal(t, apperr.CodeForbidden, codeOf(t, err))
	_, _, err = f.svc.Issue(ctx, unassigned, reg, issue(nil, false), httpx.Meta{})
	require.Equal(t, apperr.CodeForbidden, codeOf(t, err), "没被指派不能发放")
	events, err := f.svc.ListEvents(ctx, unassigned)
	require.NoError(t, err)
	require.Empty(t, events)

	expired := f.staff(t, iam.RoleRaceStaff)
	f.assign(t, expired.ID, now.Add(-48*time.Hour), now.Add(-time.Hour), true)
	_, err = f.svc.Station(ctx, expired, f.event.ID, "")
	require.Equal(t, apperr.CodeForbidden, codeOf(t, err), "指派过期不能操作")

	disabled := f.staff(t, iam.RoleRaceSupervisor)
	f.assign(t, disabled.ID, now.Add(-time.Hour), now.Add(time.Hour), false)
	_, err = f.svc.Station(ctx, disabled, f.event.ID, "")
	require.Equal(t, apperr.CodeForbidden, codeOf(t, err), "指派停用不能操作")

	active := f.staff(t, iam.RoleRaceStaff)
	f.assign(t, active.ID, now.Add(-time.Hour), now.Add(time.Hour), true)
	events, err = f.svc.ListEvents(ctx, active)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, f.event.ID, events[0].ID)
	_, err = f.svc.Station(ctx, active, f.event.ID, "")
	require.NoError(t, err)

	// OPS 不看指派
	ops := f.staff(t, iam.RoleOps)
	_, err = f.svc.Station(ctx, ops, f.event.ID, "")
	require.NoError(t, err)
}

func TestSearchFindsByReferenceNamePhoneAndBib(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ops := f.staff(t, iam.RoleOps)
	dara := f.registration(t, "Sok Dara", "+85512345678", "CONFIRMED", "ALL")
	f.registration(t, "Chan Lina", "+85598760000", "PENDING", "ALL")
	testfixture.Exec(t, f.pool, `INSERT INTO bib_ranges (event_id, category_id, range_from, range_to, assign_mode, display_digits)
		VALUES ($1, $2, 1, 999, 'AUTO', 4)`, f.event.ID, f.event.CategoryIDs[0])
	testfixture.Exec(t, f.pool, `INSERT INTO bib_assignments (event_id, bib_number, registration_id, status, assign_method)
		VALUES ($1, 42, $2, 'ASSIGNED', 'AUTO')`, f.event.ID, dara)

	var orderNo, regNo string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT o.order_no, r.reg_no FROM registrations r
		JOIN order_participants op ON op.id = r.order_participant_id JOIN reg_orders o ON o.id = op.order_id
		WHERE r.id = $1`, dara).Scan(&orderNo, &regNo))

	for _, q := range []string{orderNo, regNo, "sok", "5678", "0042", "42"} {
		st, err := f.svc.Station(ctx, ops, f.event.ID, q)
		require.NoError(t, err, q)
		require.Len(t, st.Results, 1, q)
		e := st.Results[0]
		require.Equal(t, dara, e.RegistrationID, q)
		require.Equal(t, "0042", *e.Bib)
		require.Equal(t, "5678", *e.PhoneLast4, "只给手机号后四位")
		require.Nil(t, e.BlockReason)
	}

	st, err := f.svc.Station(ctx, ops, f.event.ID, "lina")
	require.NoError(t, err)
	require.Len(t, st.Results, 1)
	require.Equal(t, racepack.BlockNotPaid, *st.Results[0].BlockReason, "待付款也要搜得到，并标出不能发放")
	require.Equal(t, int32(1), st.Confirmed, "进度只算已确认的报名")
	require.Equal(t, int32(0), st.Picked)
}

func TestIssueSelfProxyAndIdempotency(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	staff := f.staff(t, iam.RoleRaceStaff)
	f.assign(t, staff.ID, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), true)
	reg := f.registration(t, "Sok Dara", "+85512345678", "CONFIRMED", "ALL")

	in := issue(testfixture.Ptr("  Chan Lina  "), false)
	outcome, e, err := f.svc.Issue(ctx, staff, reg, in, httpx.Meta{})
	require.NoError(t, err)
	require.Equal(t, racepack.OutcomeApplied, outcome)
	require.True(t, e.Picked)
	require.Equal(t, "Chan Lina", *e.ProxyName, "代领人姓名去掉首尾空格")
	require.Equal(t, staff.FullName, *e.PickedByName)

	// 网络重试：同一 clientEventId 不再记流水
	outcome, _, err = f.svc.Issue(ctx, staff, reg, in, httpx.Meta{})
	require.NoError(t, err)
	require.Equal(t, racepack.OutcomeAlready, outcome)
	require.Equal(t, 1, testfixture.Count(t, f.pool, `SELECT count(*) FROM race_pack_scan_logs WHERE registration_id = $1`, reg))

	// 另一台设备再次扫到：ALREADY，并记一条流水
	outcome, e, err = f.svc.Issue(ctx, staff, reg, issue(nil, false), httpx.Meta{})
	require.NoError(t, err)
	require.Equal(t, racepack.OutcomeAlready, outcome)
	require.Equal(t, "Chan Lina", *e.ProxyName, "重复扫码不改变原来的领取记录")
	require.Equal(t, 1, testfixture.Count(t, f.pool,
		`SELECT count(*) FROM race_pack_scan_logs WHERE registration_id = $1 AND outcome = 'ALREADY'`, reg))

	st, err := f.svc.Station(ctx, staff, f.event.ID, "")
	require.NoError(t, err)
	require.Equal(t, int32(1), st.Picked)
	require.Len(t, st.Recent, 1)
	require.Equal(t, "Chan Lina", *st.Recent[0].ProxyName)
	require.Equal(t, 1, testfixture.Count(t, f.pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'racepack.issue' AND entity_id = $1`, reg))

	// clientEventId 不能挪给别的报名用
	other := f.registration(t, "Lim Sophea", "+85511112222", "CONFIRMED", "ALL")
	_, _, err = f.svc.Issue(ctx, staff, other, in, httpx.Meta{})
	require.Equal(t, apperr.CodeIdempotencyKeyReused, codeOf(t, err))
}

func TestIssueBlocksUnpaidAndCancelled(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ops := f.staff(t, iam.RoleRaceSupervisor)
	f.assign(t, ops.ID, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), true)

	for _, status := range []string{"PENDING", "CANCELLED"} {
		reg := f.registration(t, "Runner "+status, "+85512340000", status, "ALL")
		_, _, err := f.svc.Issue(ctx, ops, reg, issue(nil, false), httpx.Meta{})
		require.Equal(t, apperr.CodeRacepackNotPaid, codeOf(t, err), status)
		require.Equal(t, 0, testfixture.Count(t, f.pool, `SELECT count(*) FROM race_pack_facts WHERE registration_id = $1`, reg))
		require.Equal(t, 1, testfixture.Count(t, f.pool,
			`SELECT count(*) FROM race_pack_scan_logs WHERE registration_id = $1 AND outcome = 'REJECTED'`, reg),
			"被拦下也要留一条流水")
	}
}

func TestLocalRateNeedsIDCheck(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	staff := f.staff(t, iam.RoleRaceStaff)
	f.assign(t, staff.ID, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), true)
	reg := f.registration(t, "Sok Dara", "+85512345678", "CONFIRMED", "LOCAL")

	_, _, err := f.svc.Issue(ctx, staff, reg, issue(nil, false), httpx.Meta{})
	require.Equal(t, apperr.CodeRacepackIDRequired, codeOf(t, err))

	_, e, err := f.svc.Issue(ctx, staff, reg, issue(nil, true), httpx.Meta{})
	require.NoError(t, err)
	require.True(t, e.Picked)
	require.True(t, e.IDVerified)
	require.Equal(t, 1, testfixture.Count(t, f.pool,
		`SELECT count(*) FROM race_pack_scan_logs WHERE registration_id = $1 AND action = 'VERIFY_ID'`, reg))
}

func TestUndoNeedsReasonAndPick(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sup := f.staff(t, iam.RoleRaceSupervisor)
	f.assign(t, sup.ID, time.Now().Add(-time.Hour), time.Now().Add(time.Hour), true)
	reg := f.registration(t, "Sok Dara", "+85512345678", "CONFIRMED", "ALL")

	undo := racepack.UndoInput{ClientEventID: uuid.New(), DeviceID: "phone-1", Reason: "发错人"}
	_, _, err := f.svc.Undo(ctx, sup, reg, undo, httpx.Meta{})
	require.Equal(t, apperr.CodeRacepackNotPicked, codeOf(t, err))

	_, _, err = f.svc.Issue(ctx, sup, reg, issue(testfixture.Ptr("Chan Lina"), false), httpx.Meta{})
	require.NoError(t, err)

	_, _, err = f.svc.Undo(ctx, sup, reg, racepack.UndoInput{ClientEventID: uuid.New(), DeviceID: "phone-1", Reason: "  "}, httpx.Meta{})
	require.Equal(t, apperr.CodeValidation, codeOf(t, err), "撤销必须写原因")

	outcome, e, err := f.svc.Undo(ctx, sup, reg, undo, httpx.Meta{})
	require.NoError(t, err)
	require.Equal(t, racepack.OutcomeApplied, outcome)
	require.False(t, e.Picked)
	require.Nil(t, e.ProxyName)
	require.Equal(t, 1, testfixture.Count(t, f.pool,
		`SELECT count(*) FROM race_pack_scan_logs WHERE registration_id = $1 AND action = 'UNDO' AND reason = '发错人'`, reg))
}

func TestPutAssignmentOnlyForFieldRoles(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	admin := f.staff(t, iam.RoleAdmin)
	staff := f.staff(t, iam.RoleRaceStaff)
	finance := f.staff(t, iam.RoleFinance)
	from, until := time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour)

	list, err := f.svc.PutAssignment(ctx, admin, f.event.ID, staff.ID, from, until, true, httpx.Meta{})
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, staff.ID, list[0].StaffID)
	events, err := f.svc.ListEvents(ctx, staff)
	require.NoError(t, err)
	require.Len(t, events, 1, "指派后现场人员能看到这场赛事")

	_, err = f.svc.PutAssignment(ctx, admin, f.event.ID, staff.ID, from, until, false, httpx.Meta{})
	require.NoError(t, err)
	events, err = f.svc.ListEvents(ctx, staff)
	require.NoError(t, err)
	require.Empty(t, events, "停用后看不到")

	_, err = f.svc.PutAssignment(ctx, admin, f.event.ID, finance.ID, from, until, true, httpx.Meta{})
	require.Equal(t, apperr.CodeValidation, codeOf(t, err), "非现场角色不做指派")
	_, err = f.svc.PutAssignment(ctx, admin, f.event.ID, staff.ID, until, from, true, httpx.Meta{})
	require.Equal(t, apperr.CodeValidation, codeOf(t, err), "结束必须晚于开始")
}
