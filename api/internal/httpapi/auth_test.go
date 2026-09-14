package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
)

const authTestSecret = "0123456789abcdef0123456789abcdef"

type authFixture struct {
	router *gin.Engine
	svc    *iam.Service
	cat    *i18n.Catalog
}

func newAuthFixture(t *testing.T) authFixture {
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
		Env:     "dev",
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
	mw := AuthMiddleware(f.svc, auths)
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
