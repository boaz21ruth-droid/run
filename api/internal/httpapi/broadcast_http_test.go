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

	"werun/api/internal/broadcast"
	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/testfixture"
)

func TestBroadcastHTTPPermissions(t *testing.T) {
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
		Broadcast: broadcast.NewService(pool, notifytest.New(t, pool), time.Now),
		Env:       "dev",
	}), iam: iamSvc, catalog: catalog, pool: pool}
	eventID := testfixture.RaceEvent(t, pool, testfixture.EventOpts{Slug: "bcast-http", Categories: []testfixture.CategoryOpts{{Code: "10K", Capacity: 10}}}).ID
	path := fmt.Sprintf("/api/admin/events/%d/broadcasts", eventID)
	body := map[string]any{"audience": "PAID", "body": "Hello"}

	support := env.sessionCookie(t, iam.RoleSupport, "bcast.support")
	require.Equal(t, http.StatusForbidden, env.do(t, http.MethodGet, path, nil, support, nil).Code)
	finance := env.sessionCookie(t, iam.RoleFinance, "bcast.finance")
	rec := env.do(t, http.MethodGet, path, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, eventsDecode[apigen.BroadcastBoard](t, rec).Audiences, 4)
	require.Equal(t, http.StatusForbidden, env.do(t, http.MethodPost, path, body, finance, adminClientHeader).Code, "财务不能群发")
	ops := env.sessionCookie(t, iam.RoleOps, "bcast.ops")
	rec = env.do(t, http.MethodPost, path, body, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, "还没人报名")
	require.Equal(t, http.StatusUnauthorized, env.do(t, http.MethodGet, "/api/app/notices", nil, nil, nil).Code)
}
