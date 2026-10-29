package httpapi_test

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/racepack"
	"werun/api/internal/testfixture"
)

func newRacepackEnv(t *testing.T) eventsEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:      logx.New("error", io.Discard),
		Catalog:  catalog,
		Pool:     pool,
		IAM:      iamSvc,
		Events:   event.NewService(pool),
		Racepack: racepack.NewService(pool, time.Now),
		Env:      "dev",
	})
	return eventsEnv{router: router, iam: iamSvc, catalog: catalog, pool: pool}
}

func TestRacepackHTTPPermissions(t *testing.T) {
	env := newRacepackEnv(t)
	ev := testfixture.RaceEvent(t, env.pool, testfixture.EventOpts{
		Slug: "kit-http", Categories: []testfixture.CategoryOpts{{Code: "21K", Capacity: 10}},
	})
	station := fmt.Sprintf("/api/admin/racepack/events/%d", ev.ID)
	assignments := fmt.Sprintf("/api/admin/events/%d/staff-assignments", ev.ID)

	finance := env.sessionCookie(t, iam.RoleFinance, "kit.finance")
	rec := env.do(t, http.MethodGet, station, nil, finance, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "财务没有领物权限")

	staff := env.sessionCookie(t, iam.RoleRaceStaff, "kit.staff")
	rec = env.do(t, http.MethodGet, station, nil, staff, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "没被指派的现场人员看不到")

	undo := map[string]any{"clientEventId": uuid.NewString(), "deviceId": "d1", "reason": "x"}
	rec = env.do(t, http.MethodPost, "/api/admin/racepack/registrations/1/undo", undo, staff, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "现场工作人员不能撤销，只有现场主管 / 运营可以")

	ops := env.sessionCookie(t, iam.RoleOps, "kit.ops")
	rec = env.do(t, http.MethodGet, "/api/admin/staff", nil, ops, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "指派只有管理员能做")

	admin := env.sessionCookie(t, iam.RoleAdmin, "kit.admin")
	rec = env.do(t, http.MethodGet, "/api/admin/staff", nil, admin, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var staffID int64
	for _, m := range eventsDecode[apigen.StaffList](t, rec).Items {
		if m.Username == "kit.staff" {
			staffID = m.Id
		}
	}
	require.NotZero(t, staffID)

	body := map[string]any{
		"validFrom":  time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"validUntil": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"enabled":    true,
	}
	rec = env.do(t, http.MethodPut, fmt.Sprintf("%s/%d", assignments, staffID), body, admin, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Len(t, eventsDecode[apigen.EventAssignmentList](t, rec).Items, 1)

	rec = env.do(t, http.MethodGet, station+"?q=nobody", nil, staff, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	st := eventsDecode[apigen.RacepackStation](t, rec)
	require.Equal(t, ev.ID, st.Event.Id)
	require.Empty(t, st.Results)

	rec = env.do(t, http.MethodGet, "/api/admin/racepack/events", nil, staff, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, eventsDecode[apigen.RacepackEventList](t, rec).Items, 1)
}
