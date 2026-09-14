package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/pricing"
)

type eventsEnv struct {
	router  http.Handler
	iam     *iam.Service
	catalog *i18n.Catalog
	pool    *pgxpool.Pool
}

func newEventsEnv(t *testing.T) eventsEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)

	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Events:  event.NewService(pool),
		Pricing: pricing.NewService(pool, time.Now),
		Env:     "dev",
	})
	return eventsEnv{router: router, iam: iamSvc, catalog: catalog, pool: pool}
}

func (e eventsEnv) sessionCookie(t *testing.T, role iam.Role, username string) *http.Cookie {
	t.Helper()
	const password = "Correct-Horse-Battery-9"
	ctx := context.Background()
	_, err := e.iam.CreateStaff(ctx, username, "HTTP "+string(role), role, password)
	require.NoError(t, err)
	token, _, err := e.iam.Login(ctx, username, password, httpx.Meta{IP: "127.0.0.1", UserAgent: "events-http-test"})
	require.NoError(t, err)
	return &http.Cookie{Name: iam.CookieName, Value: token}
}

func (e eventsEnv) do(t *testing.T, method, path string, body any, cookie *http.Cookie, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequestWithContext(context.Background(), method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, values := range header {
		for _, v := range values {
			req.Header.Add(k, v)
		}
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func eventsCreateBody() map[string]any {
	return map[string]any{
		"slug":          "pphm-2026",
		"eventType":     "RACE",
		"organizerType": "OFFICIAL",
		"name": map[string]string{
			"zh": "金边半程马拉松 2026",
			"en": "Phnom Penh Half Marathon 2026",
			"km": "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
		},
		"city":     "Phnom Penh",
		"raceDate": "2026-11-15",
		"categories": []map[string]any{{
			"code": "21K",
			"name": map[string]string{
				"zh": "半程 21K",
				"en": "Half Marathon 21K",
				"km": "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K",
			},
			"distanceM": 21097,
			"capacity":  800,
			"startAt":   "2026-11-15T06:00:00+07:00",
			"cutoffAt":  "2026-11-15T09:30:00+07:00",
		}},
	}
}

func eventsDecode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &v), rec.Body.String())
	return v
}

func TestOpsCreatesAndPublishesEventThenPublicSeesIt(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.http")
	adminClient := http.Header{httpx.HeaderClient: []string{"admin"}}

	rec := env.do(t, http.MethodPost, "/api/admin/events", eventsCreateBody(), ops, adminClient)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.AdminEvent](t, rec)
	require.Equal(t, "DRAFT", string(created.Status))
	require.False(t, created.PublicVisible)
	require.Len(t, created.Categories, 1)

	rec = env.do(t, http.MethodGet, "/api/events", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Empty(t, eventsDecode[apigen.PublicEventList](t, rec).Items, "草稿不应出现在公开列表")

	rec = env.do(t, http.MethodPost, fmt.Sprintf("/api/admin/events/%d/publish", created.Id), nil, ops, adminClient)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	published := eventsDecode[apigen.AdminEvent](t, rec)
	require.Equal(t, "PUBLISHED", string(published.Status))
	require.True(t, published.PublicVisible)
	require.NotNil(t, published.PublishedAt)

	rec = env.do(t, http.MethodGet, "/api/events?lang=km", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.PublicEventList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, "pphm-2026", list.Items[0].Slug)
	require.Equal(t, "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦", list.Items[0].Name)
	require.Equal(t, "2026-11-15", list.Items[0].RaceDate.Format("2006-01-02"))
	require.Equal(t, "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K", list.Items[0].Categories[0].Name)

	rec = env.do(t, http.MethodGet, "/api/events/pphm-2026?lang=en", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "Phnom Penh Half Marathon 2026", eventsDecode[apigen.PublicEvent](t, rec).Name)

	rec = env.do(t, http.MethodGet, "/api/events/does-not-exist", nil, nil, nil)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeEventNotFound, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}

func TestAdminRoleCanReadButCannotCreateEvents(t *testing.T) {
	env := newEventsEnv(t)
	admin := env.sessionCookie(t, iam.RoleAdmin, "admin.http")

	rec := env.do(t, http.MethodPost, "/api/admin/events", eventsCreateBody(), admin, http.Header{
		httpx.HeaderClient: []string{"admin"},
		"Accept-Language":  []string{"zh-CN,zh;q=0.9"},
	})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeForbidden, body.Error.Code)
	require.Equal(t, env.catalog.T(i18n.ZH, apperr.CodeForbidden, nil), body.Error.Message)

	rec = env.do(t, http.MethodGet, "/api/admin/events", nil, admin, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestAdminEventsRequireSession(t *testing.T) {
	env := newEventsEnv(t)

	rec := env.do(t, http.MethodGet, "/api/admin/events", nil, nil, nil)

	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeUnauthenticated, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}

var adminClientHeader = http.Header{httpx.HeaderClient: []string{"admin"}}

// createPublishedEvent 以 OPS 身份新建并发布 eventsCreateBody 描述的赛事，返回赛事。
func (e eventsEnv) createPublishedEvent(t *testing.T, ops *http.Cookie) apigen.AdminEvent {
	t.Helper()
	rec := e.do(t, http.MethodPost, "/api/admin/events", eventsCreateBody(), ops, adminClientHeader)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.AdminEvent](t, rec)
	rec = e.do(t, http.MethodPost, fmt.Sprintf("/api/admin/events/%d/publish", created.Id), nil, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	return eventsDecode[apigen.AdminEvent](t, rec)
}

func TestAdminEventDetailAndRegistrationSwitch(t *testing.T) {
	env := newEventsEnv(t)
	ctx := context.Background()
	ops := env.sessionCookie(t, iam.RoleOps, "ops.regswitch")
	finance := env.sessionCookie(t, iam.RoleFinance, "finance.regswitch")
	support := env.sessionCookie(t, iam.RoleSupport, "support.regswitch")
	ev := env.createPublishedEvent(t, ops)
	detailPath := fmt.Sprintf("/api/admin/events/%d", ev.Id)
	registrationPath := detailPath + "/registration"

	rec := env.do(t, http.MethodGet, detailPath, nil, finance, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := eventsDecode[apigen.AdminEvent](t, rec)
	require.Equal(t, "Asia/Phnom_Penh", detail.Timezone)
	require.False(t, detail.RegistrationOpen)
	require.Nil(t, detail.RegistrationOpensAt)
	require.Len(t, detail.Categories, 1)

	rec = env.do(t, http.MethodGet, detailPath, nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 没有 event_config")

	openBody := map[string]any{"open": true, "opensAt": "2026-09-20T08:00:00+07:00", "closesAt": nil}
	rec = env.do(t, http.MethodPatch, registrationPath, openBody, finance, adminClientHeader)
	require.Equal(t, http.StatusForbidden, rec.Code, "FINANCE 对 event_config 只读")

	rec = env.do(t, http.MethodPatch, registrationPath+"?lang=zh", openBody, ops, adminClientHeader)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeRegistrationNotReady, body.Error.Code)
	require.Equal(t, env.catalog.T(i18n.ZH, apperr.CodeRegistrationNotReady, nil), body.Error.Message)
	require.Equal(t, "这些组别还没有价格档：21K。", body.Error.Fields["priceRules"])
	require.Contains(t, body.Error.Fields, "paymentAccounts")

	var ruleID, fileID int64
	require.NoError(t, env.pool.QueryRow(ctx,
		`INSERT INTO price_rules (event_id, name, audience, price_cents) VALUES ($1, '{"en":"Std"}', 'ALL', 2500) RETURNING id`,
		ev.Id).Scan(&ruleID))
	_, err := env.pool.Exec(ctx, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`,
		ev.Categories[0].Id, ruleID)
	require.NoError(t, err)
	require.NoError(t, env.pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/regswitch.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 10, '\x01', 'SYSTEM') RETURNING id`).Scan(&fileID))
	_, err = env.pool.Exec(ctx,
		`INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id, scope)
		 VALUES ('ABA USD', 'ABA', 'WERUN CO', '***123', 'USD', $1, 'ALL')`, fileID)
	require.NoError(t, err)

	rec = env.do(t, http.MethodPatch, registrationPath, openBody, ops, adminClientHeader)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	opened := eventsDecode[apigen.AdminEvent](t, rec)
	require.True(t, opened.RegistrationOpen)
	require.NotNil(t, opened.RegistrationOpensAt)
	require.Equal(t, "2026-09-20T01:00:00Z", opened.RegistrationOpensAt.UTC().Format(time.RFC3339))
	require.Nil(t, opened.RegistrationClosesAt)

	rec = env.do(t, http.MethodGet, "/api/admin/events/999999", nil, ops, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, apperr.CodeEventNotFound, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}
