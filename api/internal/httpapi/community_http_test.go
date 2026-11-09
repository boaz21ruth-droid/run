package httpapi_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/community"
	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/testfixture"
)

func TestCommunityHTTPPermissions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	runners := testfixture.RunnerService(t, pool, time.Now)
	env := eventsEnv{router: httpapi.NewRouter(httpapi.RouterDeps{
		Log:       logx.New("error", io.Discard),
		Catalog:   catalog,
		Pool:      pool,
		IAM:       iamSvc,
		Events:    event.NewService(pool),
		Runner:    runners,
		Community: community.NewService(pool, runners, time.Now),
		Env:       "dev",
	}), iam: iamSvc, catalog: catalog, pool: pool}

	rec := env.do(t, http.MethodGet, "/api/community/feed?kind=CLUB", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, "跑团页公开")
	require.Empty(t, eventsDecode[apigen.CommunityFeed](t, rec).Items)
	rec = env.do(t, http.MethodPost, "/api/app/community/checkin", map[string]any{}, nil, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code, "签到要登录")

	support := env.sessionCookie(t, iam.RoleSupport, "community.support")
	rec = env.do(t, http.MethodGet, "/api/admin/community/activities", nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code)
	admin := env.sessionCookie(t, iam.RoleAdmin, "community.admin")
	rec = env.do(t, http.MethodGet, "/api/admin/community/activities?status=REVIEWING", nil, admin, nil)
	require.Equal(t, http.StatusOK, rec.Code, "管理员可以看")
	rec = env.do(t, http.MethodPost, "/api/admin/community/activities/1/approve", nil, admin, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "管理员不能审核")
	ops := env.sessionCookie(t, iam.RoleOps, "community.ops")
	rec = env.do(t, http.MethodPost, "/api/admin/community/activities/999/approve", nil, ops, adminClientHeader)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
