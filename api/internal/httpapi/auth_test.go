package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/runner"
)

const authTestSecret = "0123456789abcdef0123456789abcdef"

type authFixture struct {
	router *gin.Engine
	svc    *iam.Service
	cat    *i18n.Catalog
}

func newAuthFixture(t *testing.T) authFixture {
	t.Helper()
	return newAuthFixtureWithEnv(t, "dev")
}

// newAuthFixtureWithEnv 与 newAuthFixture 相同，但可以指定 RouterDeps.Env（例如 "prod"
// 用来验证会话 Cookie 的 Secure 属性）。
func newAuthFixtureWithEnv(t *testing.T, env string) authFixture {
	t.Helper()
	pool := dbtest.NewPool(t)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	svc := iam.NewService(pool, []byte(authTestSecret), iam.NewLoginLimiter(time.Now), time.Now)
	_, err = svc.CreateStaff(context.Background(), "ops.chan", "Chanthou Ny", iam.RoleOps, "correct-horse-1")
	require.NoError(t, err)
	router := NewRouter(RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: cat,
		Pool:    pool,
		IAM:     svc,
		Env:     env,
	})
	return authFixture{router: router, svc: svc, cat: cat}
}

type request struct {
	method   string
	target   string
	body     string
	asClient bool
	cookie   *http.Cookie
}

func (f authFixture) do(r request) *httptest.ResponseRecorder {
	var body io.Reader
	if r.body != "" {
		body = strings.NewReader(r.body)
	}
	req := httptest.NewRequestWithContext(context.Background(), r.method, r.target, body)
	if r.body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.asClient {
		req.Header.Set(httpx.HeaderClient, "admin")
	}
	if r.cookie != nil {
		req.AddCookie(r.cookie)
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == iam.CookieName {
			return c
		}
	}
	t.Fatalf("response has no %s cookie", iam.CookieName)
	return nil
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) apigen.ErrorResponse {
	t.Helper()
	var body apigen.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func (f authFixture) login(t *testing.T) *http.Cookie {
	t.Helper()
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login",
		body:     `{"username":"ops.chan","password":"correct-horse-1"}`,
		asClient: true,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	return sessionCookie(t, rec)
}

func TestAdminLoginSetsSessionCookie(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login",
		body:     `{"username":"ops.chan","password":"correct-horse-1"}`,
		asClient: true,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	cookie := sessionCookie(t, rec)
	assert.NotEmpty(t, cookie.Value)
	assert.Equal(t, "/api/admin", cookie.Path)
	assert.True(t, cookie.HttpOnly)
	assert.False(t, cookie.Secure, "dev environment")
	assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)

	var me apigen.Me
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	assert.Equal(t, "ops.chan", me.Staff.Username)
	assert.Equal(t, apigen.RoleOPS, me.Staff.Role)
	assert.Equal(t, apigen.AccessWrite, me.Permissions["event_config"])
	assert.Equal(t, apigen.AccessWrite, me.Permissions["event_publish"])
}

func TestAdminLoginSetsSecureCookieInProd(t *testing.T) {
	f := newAuthFixtureWithEnv(t, "prod")
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login",
		body:     `{"username":"ops.chan","password":"correct-horse-1"}`,
		asClient: true,
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	cookie := sessionCookie(t, rec)
	assert.True(t, cookie.Secure, "prod environment")
}

func TestAdminLoginWrongPasswordIsLocalized(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{
		method:   http.MethodPost,
		target:   "/api/admin/auth/login?lang=zh",
		body:     `{"username":"ops.chan","password":"wrong-password"}`,
		asClient: true,
	})
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	body := decodeError(t, rec)
	assert.Equal(t, apperr.CodeInvalidCredentials, body.Error.Code)
	assert.Equal(t, f.cat.T(i18n.ZH, apperr.CodeInvalidCredentials, nil), body.Error.Message)
}

func TestAdminLoginRequiresClientHeader(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{
		method: http.MethodPost,
		target: "/api/admin/auth/login",
		body:   `{"username":"ops.chan","password":"correct-horse-1"}`,
	})
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, apperr.CodeCSRF, decodeError(t, rec).Error.Code)
}

func TestAdminMeRequiresSession(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{method: http.MethodGet, target: "/api/admin/me?lang=zh"})

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	body := decodeError(t, rec)
	assert.Equal(t, apperr.CodeUnauthenticated, body.Error.Code)
	assert.Equal(t, f.cat.T(i18n.ZH, apperr.CodeUnauthenticated, nil), body.Error.Message)
}

func TestAdminMeWithSession(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{method: http.MethodGet, target: "/api/admin/me", cookie: f.login(t)})

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var me apigen.Me
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	assert.Equal(t, "Chanthou Ny", me.Staff.FullName)
	assert.Equal(t, apigen.AccessWrite, me.Permissions["event_config"])
}

func TestAdminLogoutRequiresClientHeader(t *testing.T) {
	f := newAuthFixture(t)
	rec := f.do(request{method: http.MethodPost, target: "/api/admin/auth/logout", cookie: f.login(t)})

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, apperr.CodeCSRF, decodeError(t, rec).Error.Code)
}

func TestAdminLogoutRevokesSession(t *testing.T) {
	f := newAuthFixture(t)
	cookie := f.login(t)

	rec := f.do(request{method: http.MethodPost, target: "/api/admin/auth/logout", asClient: true, cookie: cookie})
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	assert.Less(t, sessionCookie(t, rec).MaxAge, 0, "cookie cleared")

	rec = f.do(request{method: http.MethodGet, target: "/api/admin/me", cookie: cookie})
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAuthMiddlewarePermissions(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	_, err := f.svc.CreateStaff(ctx, "photog.sok", "Sokha Ith", iam.RolePhotographer, "correct-horse-1")
	require.NoError(t, err)
	meta := httpx.Meta{IP: "198.51.100.10"}
	opsToken, _, err := f.svc.Login(ctx, "ops.chan", "correct-horse-1", meta)
	require.NoError(t, err)
	photogToken, _, err := f.svc.Login(ctx, "photog.sok", "correct-horse-1", meta)
	require.NoError(t, err)

	auths := map[string]apigen.OperationAuth{
		"FakeWrite": {Kind: apigen.AuthPermission, Permission: string(iam.PermEventConfig), Access: string(iam.AccessWrite)},
	}
	mw := AuthMiddleware(f.svc, nil, auths, logx.New("error", io.Discard))
	next := func(c *gin.Context, _ any) (any, error) {
		staff, ok := iam.StaffFrom(c)
		require.True(t, ok)
		return staff.Username, nil
	}
	call := func(operationID, token string) (any, error) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/admin/fake", nil)
		if token != "" {
			c.Request.AddCookie(&http.Cookie{Name: iam.CookieName, Value: token})
		}
		return mw(next, operationID)(c, nil)
	}

	got, err := call("FakeWrite", opsToken)
	require.NoError(t, err)
	assert.Equal(t, "ops.chan", got)

	_, err = call("FakeWrite", photogToken)
	appErr, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeForbidden, appErr.Code)

	_, err = call("FakeWrite", "")
	appErr, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeUnauthenticated, appErr.Code)

	_, err = call("NotInMap", opsToken)
	appErr, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeForbidden, appErr.Code)
}

// TestOperationAuthsCoversEveryStrictServerInterfaceMethod 证明 apigen.OperationAuths
// 覆盖了 StrictServerInterface 的每一个方法：新增接口时如果忘了跑 make gen-api（或
// permgen 忘了给某个操作打 x-permission），这个测试会先炸，而不是等到线上被 403 拦下来
// 才发现——见 AuthMiddleware 对"映射表里查不到"的处理与其 Warn 日志。
func TestOperationAuthsCoversEveryStrictServerInterfaceMethod(t *testing.T) {
	typ := reflect.TypeOf((*apigen.StrictServerInterface)(nil)).Elem()
	for i := 0; i < typ.NumMethod(); i++ {
		name := typ.Method(i).Name
		_, ok := apigen.OperationAuths[name]
		assert.True(t, ok, "operation %s is missing from apigen.OperationAuths; run make gen-api", name)
	}
}

func TestOperationAuthsUseKnownPermissions(t *testing.T) {
	known := map[string]bool{}
	for _, p := range iam.AllPermissions {
		known[string(p)] = true
	}
	for op, rule := range apigen.OperationAuths {
		if rule.Kind != apigen.AuthPermission {
			continue
		}
		assert.True(t, known[rule.Permission], "%s uses unknown permission %q", op, rule.Permission)
		assert.Contains(t, []string{string(iam.AccessRead), string(iam.AccessWrite)}, rule.Access, op)
	}
}

// fakeRunners 按令牌返回跑者，代替 runner.Service 的 Authenticate。
type fakeRunners map[string]runner.User

func (f fakeRunners) Authenticate(_ context.Context, token string) (runner.User, error) {
	u, ok := f[token]
	if !ok {
		return runner.User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

func TestAuthMiddlewareSeparatesRunnerTokenAndStaffCookie(t *testing.T) {
	f := newAuthFixture(t)
	staffToken, _, err := f.svc.Login(context.Background(), "ops.chan", "correct-horse-1", httpx.Meta{IP: "198.51.100.11"})
	require.NoError(t, err)
	runners := fakeRunners{"runner-token-1": {ID: 7, TelegramUserID: 10001, DisplayName: "Dara Sok", Locale: "km"}}
	auths := map[string]apigen.OperationAuth{
		"AppOp":   {Kind: apigen.AuthApp},
		"StaffOp": {Kind: apigen.AuthSession},
		"PermOp":  {Kind: apigen.AuthPermission, Permission: string(iam.PermEventConfig), Access: string(iam.AccessRead)},
	}
	mw := AuthMiddleware(f.svc, runners, auths, logx.New("error", io.Discard))
	next := func(c *gin.Context, _ any) (any, error) {
		if u, ok := runner.UserFrom(c); ok {
			return fmt.Sprintf("runner:%d", u.ID), nil
		}
		if s, ok := iam.StaffFrom(c); ok {
			return "staff:" + s.Username, nil
		}
		return "anonymous", nil
	}

	cases := []struct {
		name          string
		operation     string
		authorization string
		cookie        string
		want          string
		wantCode      string
	}{
		{name: "app op with bearer token", operation: "AppOp", authorization: "Bearer runner-token-1", want: "runner:7"},
		{name: "app op accepts lowercase scheme", operation: "AppOp", authorization: "bearer runner-token-1", want: "runner:7"},
		{name: "app op without token", operation: "AppOp", wantCode: apperr.CodeUnauthenticated},
		{name: "app op with unknown token", operation: "AppOp", authorization: "Bearer nope", wantCode: apperr.CodeUnauthenticated},
		{name: "app op with other scheme", operation: "AppOp", authorization: "Basic runner-token-1", wantCode: apperr.CodeUnauthenticated},
		{name: "app op with staff cookie only", operation: "AppOp", cookie: staffToken, wantCode: apperr.CodeUnauthenticated},
		{name: "app op ignores staff cookie when bearer is valid", operation: "AppOp", authorization: "Bearer runner-token-1", cookie: staffToken, want: "runner:7"},
		{name: "session op with bearer only", operation: "StaffOp", authorization: "Bearer runner-token-1", wantCode: apperr.CodeUnauthenticated},
		{name: "permission op with bearer only", operation: "PermOp", authorization: "Bearer runner-token-1", wantCode: apperr.CodeUnauthenticated},
		{name: "session op with staff cookie", operation: "StaffOp", cookie: staffToken, want: "staff:ops.chan"},
		{name: "permission op with staff cookie", operation: "PermOp", cookie: staffToken, want: "staff:ops.chan"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/fake", nil)
			if tc.authorization != "" {
				c.Request.Header.Set("Authorization", tc.authorization)
			}
			if tc.cookie != "" {
				c.Request.AddCookie(&http.Cookie{Name: iam.CookieName, Value: tc.cookie})
			}

			got, err := mw(next, tc.operation)(c, nil)

			if tc.wantCode != "" {
				appErr, ok := apperr.As(err)
				require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
				assert.Equal(t, tc.wantCode, appErr.Code)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}
