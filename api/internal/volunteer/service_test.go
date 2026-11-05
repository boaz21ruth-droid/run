package volunteer_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration/regtest"
	"werun/api/internal/runner"
	"werun/api/internal/volunteer"
)

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	return ae.Code
}

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	var ae *apperr.Error
	require.True(t, errors.As(err, &ae), "want apperr, got %v", err)
	out := map[string]string{}
	for k, v := range ae.Fields {
		out[k] = v.Key
	}
	return out
}

func text(s string) i18n.Text { return i18n.Text{i18n.ZH: s, i18n.EN: s, i18n.KM: s} }

func day(s string) time.Time {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return d
}

type env struct {
	*regtest.Env
	svc *volunteer.Service
	ops iam.Staff
}

func setup(t *testing.T) env {
	t.Helper()
	e := regtest.New(t)
	return env{Env: e, svc: volunteer.NewService(e.Pool, e.Clock.Now), ops: e.NewStaff(t, iam.RoleOps, "vol-ops")}
}

func (e env) apply(t *testing.T, u runner.User, in volunteer.ApplyInput) (volunteer.Application, error) {
	t.Helper()
	return e.svc.Apply(context.Background(), u, regtest.EventSlug, in, httpx.Meta{})
}

func applyInput(roles ...int64) volunteer.ApplyInput {
	return volunteer.ApplyInput{FullName: " Sok Dara ", Phone: "+855 12 345 678", FullAvailability: true, RoleIDs: roles, ConductAccepted: true}
}

func TestVolunteerApplyAndAssign(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	dara := e.NewRunner(t, 30001, "zh")

	// 未开放
	_, err := e.apply(t, dara, applyInput(1))
	require.Equal(t, apperr.CodeVolunteerClosed, codeOf(t, err))

	// 开放必须给日期
	_, err = e.svc.UpdateSettings(ctx, e.ops, e.EventID, volunteer.Settings{Open: true})
	assert.Equal(t, map[string]string{"dates": "field.required"}, fieldsOf(t, err))
	board, err := e.svc.UpdateSettings(ctx, e.ops, e.EventID, volunteer.Settings{
		Open: true, Dates: []time.Time{day("2026-11-15"), day("2026-11-13"), day("2026-11-13")}, Note: text(" 需柬英双语 "),
	})
	require.NoError(t, err)
	assert.Equal(t, []time.Time{day("2026-11-13"), day("2026-11-15")}, board.Settings.Dates, "去重并排序")
	assert.Equal(t, "需柬英双语", board.Settings.Note[i18n.ZH])

	board, err = e.svc.CreateRole(ctx, e.ops, e.EventID, volunteer.RoleInput{Name: text("检录台"), Schedule: text("16:00 起"), Capacity: 1})
	require.NoError(t, err)
	board, err = e.svc.CreateRole(ctx, e.ops, e.EventID, volunteer.RoleInput{Name: text("补给站"), Capacity: 2, SortOrder: 1})
	require.NoError(t, err)
	require.Len(t, board.Roles, 2)
	checkin, water := board.Roles[0].ID, board.Roles[1].ID
	_, err = e.svc.CreateRole(ctx, e.ops, e.EventID, volunteer.RoleInput{Name: i18n.Text{i18n.ZH: "x"}, Capacity: -1})
	assert.Equal(t, map[string]string{"name.en": "field.required", "name.km": "field.required", "capacity": "field.invalid"}, fieldsOf(t, err))

	// 申请校验：日期须是列出的、最多 3 个岗位、要同意准则
	bad := applyInput(checkin, water, 999, 998)
	bad.FullAvailability = false
	bad.Dates = []time.Time{day("2026-11-14")}
	bad.ConductAccepted = false
	bad.Phone = "012"
	_, err = e.apply(t, dara, bad)
	assert.Equal(t, map[string]string{
		"dates": "field.invalid", "roleIds": "field.volunteer_roles_max", "conductAccepted": "field.required", "phone": "field.invalid",
	}, fieldsOf(t, err))

	in := applyInput(checkin, water)
	in.FullAvailability = false
	in.Dates = []time.Time{day("2026-11-15")}
	app, err := e.apply(t, dara, in)
	require.NoError(t, err)
	assert.Equal(t, volunteer.StatusPending, app.Status)
	assert.Equal(t, "Sok Dara", app.FullName)
	assert.Equal(t, "+85512345678", app.Phone)
	_, err = e.apply(t, dara, in)
	require.Equal(t, apperr.CodeVolunteerApplied, codeOf(t, err), "进行中的申请只有一份")

	// 席位：检录台 1 席；第二个人分配进去时满员
	sophea := e.NewRunner(t, 30002, "en")
	app2, err := e.apply(t, sophea, applyInput(checkin))
	require.NoError(t, err)
	board, err = e.svc.Board(ctx, e.EventID)
	require.NoError(t, err)
	assert.Equal(t, int32(2), board.Roles[0].Candidates)
	assert.Equal(t, int32(1), board.Roles[1].Candidates)

	board, err = e.svc.Assign(ctx, e.ops, app.ID, checkin)
	require.NoError(t, err)
	assert.Equal(t, int32(1), board.Roles[0].AssignedCount)
	_, err = e.svc.Assign(ctx, e.ops, app2.ID, checkin)
	require.Equal(t, apperr.CodeVolunteerRoleFull, codeOf(t, err))
	_, err = e.svc.Waitlist(ctx, e.ops, app2.ID)
	require.NoError(t, err)
	_, err = e.svc.UpdateRole(ctx, e.ops, checkin, volunteer.RoleInput{Name: text("检录台"), Capacity: 0, Active: true})
	assert.Equal(t, map[string]string{"capacity": "field.quota_below_taken"}, fieldsOf(t, err))

	// 换岗：检录台释放、补给站占一个；检录台空出来后候补的人可以补上
	board, err = e.svc.Assign(ctx, e.ops, app.ID, water)
	require.NoError(t, err)
	assert.Equal(t, int32(0), board.Roles[0].AssignedCount)
	assert.Equal(t, int32(1), board.Roles[1].AssignedCount)
	_, err = e.svc.Assign(ctx, e.ops, app2.ID, checkin)
	require.NoError(t, err)

	// 跑者看到分配结果；撤回释放席位，之后可以重新申请
	view, err := e.svc.GetForRunner(ctx, dara, regtest.EventSlug)
	require.NoError(t, err)
	require.NotNil(t, view.Application)
	assert.Equal(t, volunteer.StatusAssigned, view.Application.Status)
	assert.Equal(t, "补给站", view.Application.AssignedRoleName[i18n.ZH])
	assert.Equal(t, int32(1), view.Roles[1].Remaining())
	withdrawn, err := e.svc.Withdraw(ctx, dara, regtest.EventSlug, httpx.Meta{})
	require.NoError(t, err)
	assert.Equal(t, volunteer.StatusWithdrawn, withdrawn.Status)
	board, err = e.svc.Board(ctx, e.EventID)
	require.NoError(t, err)
	assert.Equal(t, int32(0), board.Roles[1].AssignedCount)
	_, err = e.svc.Assign(ctx, e.ops, app.ID, water)
	require.Equal(t, apperr.CodeVolunteerStateConflict, codeOf(t, err), "撤回的申请不能再分配")
	_, err = e.apply(t, dara, applyInput(water))
	require.NoError(t, err)

	// 拒绝已分配的人释放席位，备注给跑者看
	board, err = e.svc.Reject(ctx, e.ops, app2.ID, "  这次检录台人够了 ")
	require.NoError(t, err)
	assert.Equal(t, int32(0), board.Roles[0].AssignedCount)
	view, err = e.svc.GetForRunner(ctx, sophea, regtest.EventSlug)
	require.NoError(t, err)
	assert.Equal(t, volunteer.StatusRejected, view.Application.Status)
	assert.Equal(t, "这次检录台人够了", *view.Application.ReviewNote)

	// 停用的岗位跑者看不到，也不能选
	_, err = e.svc.UpdateRole(ctx, e.ops, checkin, volunteer.RoleInput{Name: text("检录台"), Capacity: 1, Active: false})
	require.NoError(t, err)
	view, err = e.svc.GetForRunner(ctx, sophea, regtest.EventSlug)
	require.NoError(t, err)
	require.Len(t, view.Roles, 1)
	_, err = e.apply(t, sophea, applyInput(checkin))
	assert.Equal(t, map[string]string{"roleIds": "field.invalid"}, fieldsOf(t, err))
	assert.Equal(t, 5, e.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'volunteer.review'`))
}
