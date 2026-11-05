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
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/testfixture"
)

func TestRulesAndQualificationHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	runners := testfixture.RunnerService(t, pool, time.Now)
	prices := pricing.NewService(pool, time.Now)
	env := eventsEnv{router: httpapi.NewRouter(httpapi.RouterDeps{
		Log:          logx.New("error", io.Discard),
		Catalog:      catalog,
		Pool:         pool,
		IAM:          iamSvc,
		Events:       event.NewService(pool),
		Runner:       runners,
		Pricing:      prices,
		Registration: registration.NewService(pool, runners, prices, notifytest.New(t, pool), time.Now),
		Env:          "dev",
	}), iam: iamSvc, catalog: catalog, pool: pool}

	ev := testfixture.RaceEvent(t, pool, testfixture.EventOpts{
		Slug: "rules-http", Categories: []testfixture.CategoryOpts{{Code: "21KE", Capacity: 10}, {Code: "21K", Capacity: 100}},
	})
	policyURL := fmt.Sprintf("/api/admin/events/%d/refund-policy", ev.ID)
	qualURL := fmt.Sprintf("/api/admin/categories/%d/qualification", ev.CategoryIDs[0])
	proofsURL := fmt.Sprintf("/api/admin/events/%d/qualification-proofs", ev.ID)
	policy := map[string]any{"policy": map[string]any{
		"tiers": []map[string]any{{"days": 14, "percent": 80}, {"days": 7, "percent": 50}}, "transferDays": 3,
	}}
	qual := map[string]any{"qualification": map[string]any{
		"rule":      map[string]any{"zh": "需近两年 21K 1:45 以内", "en": "21K under 1:45", "km": "21K ក្រោម 1:45"},
		"maxTimeMs": 6300000, "fallbackCategoryId": ev.CategoryIDs[1],
	}}

	support := env.sessionCookie(t, iam.RoleSupport, "rules.support")
	rec := env.do(t, http.MethodGet, proofsURL, nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "客服看不到资格证明")

	finance := env.sessionCookie(t, iam.RoleFinance, "rules.finance")
	rec = env.do(t, http.MethodGet, proofsURL, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code, "财务可以看")
	rec = env.do(t, http.MethodPut, policyURL, policy, finance, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "财务不能改退改政策")

	ops := env.sessionCookie(t, iam.RoleOps, "rules.ops")
	rec = env.do(t, http.MethodPut, policyURL, policy, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int32(3), *eventsDecode[apigen.AdminEvent](t, rec).RefundPolicy.TransferDays)
	rec = env.do(t, http.MethodPut, qualURL, qual, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = env.do(t, http.MethodGet, "/api/events/rules-http", nil, nil, http.Header{"Accept-Language": {"zh"}})
	require.Equal(t, http.StatusOK, rec.Code)
	pub := eventsDecode[apigen.PublicEvent](t, rec)
	require.Len(t, pub.RefundPolicy.Tiers, 2)
	require.NotNil(t, pub.Categories[0].Qualification)
	require.Equal(t, "需近两年 21K 1:45 以内", pub.Categories[0].Qualification.Rule)
	require.Equal(t, ev.CategoryIDs[1], pub.Categories[0].Qualification.FallbackCategoryId)
	require.Nil(t, pub.Categories[1].Qualification)

	rec = env.do(t, http.MethodPost, "/api/admin/qualification-proofs/999/approve", nil, ops, adminClientHeader)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
