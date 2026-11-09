package httpapi_test

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/testfixture"
	"werun/api/internal/volunteer"
)

func TestVolunteerHTTPPermissions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	env := eventsEnv{router: httpapi.NewRouter(httpapi.RouterDeps{
		Log:       logx.New("error", io.Discard),
		Catalog:   catalog,
		Pool:      pool,
		IAM:       iamSvc,
		Events:    event.NewService(pool),
		Volunteer: volunteer.NewService(pool, time.Now),
		Env:       "dev",
	}), iam: iamSvc, catalog: catalog, pool: pool}

	eventID := testfixture.RaceEvent(t, pool, testfixture.EventOpts{Slug: "vol-http", Categories: []testfixture.CategoryOpts{{Code: "10K", Capacity: 10}}}).ID
	board := fmt.Sprintf("/api/admin/events/%d/volunteers", eventID)
	settings := fmt.Sprintf("/api/admin/events/%d/volunteer-settings", eventID)
	body := map[string]any{"open": true, "dates": []string{"2026-11-15"}, "note": nil}

	support := env.sessionCookie(t, iam.RoleSupport, "vol.support")
	rec := env.do(t, http.MethodGet, board, nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "客服看不到志愿者")

	finance := env.sessionCookie(t, iam.RoleFinance, "vol.finance")
	rec = env.do(t, http.MethodGet, board, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	rec = env.do(t, http.MethodPut, settings, body, finance, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "财务只能看")

	ops := env.sessionCookie(t, iam.RoleOps, "vol.ops")
	rec = env.do(t, http.MethodPut, settings, body, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = env.do(t, http.MethodPost, fmt.Sprintf("/api/admin/events/%d/volunteer-roles", eventID),
		map[string]any{"name": map[string]any{"zh": "检录台", "en": "Check-in", "km": "ចុះឈ្មោះ"}, "capacity": 8}, ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.Len(t, eventsDecode[apigen.VolunteerBoard](t, rec).Roles, 1)

	rec = env.do(t, http.MethodGet, "/api/events/vol-http", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.True(t, eventsDecode[apigen.PublicEvent](t, rec).VolunteerOpen)
	rec = env.do(t, http.MethodGet, "/api/app/events/vol-http/volunteer", nil, nil, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, "申请志愿者要先登录")
}
