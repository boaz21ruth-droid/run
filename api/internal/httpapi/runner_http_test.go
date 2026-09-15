package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner"
)

const runnerBotToken = "123456:http-test-token"

type runnerEnv struct {
	router  http.Handler
	iam     *iam.Service
	catalog *i18n.Catalog
}

func newRunnerEnv(t *testing.T) runnerEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	pii, err := piicrypt.New([]byte(strings.Repeat("p", 32)))
	require.NoError(t, err)
	secret := []byte(strings.Repeat("k", 32))
	iamSvc := iam.NewService(pool, secret, iam.NewLoginLimiter(time.Now), time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Runner:  runner.NewService(pool, secret, runnerBotToken, pii, time.Now),
		Env:     "dev",
	})
	return runnerEnv{router: router, iam: iamSvc, catalog: catalog}
}

func (e runnerEnv) do(t *testing.T, method, path string, body any, header http.Header) *httptest.ResponseRecorder {
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
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func bearer(token string) http.Header {
	return http.Header{"Authorization": []string{"Bearer " + token}}
}

func (e runnerEnv) loginRunner(t *testing.T, telegramID int64, name string) apigen.AppSession {
	t.Helper()
	initData := runner.SignInitData(runnerBotToken, runner.TelegramUser{ID: telegramID, FirstName: name, LanguageCode: "en"}, time.Now())
	rec := e.do(t, http.MethodPost, "/api/app/auth/telegram", map[string]string{"initData": initData}, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var sess apigen.AppSession
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &sess))
	return sess
}

func decodeRunnerError(t *testing.T, rec *httptest.ResponseRecorder) apigen.ErrorResponse {
	t.Helper()
	var body apigen.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func TestAppLoginTelegramReturnsTokenAndMe(t *testing.T) {
	e := newRunnerEnv(t)
	before := time.Now()

	sess := e.loginRunner(t, 10001, "Dara Sok")

	assert.NotEmpty(t, sess.Token)
	assert.WithinDuration(t, before.Add(24*time.Hour), sess.ExpiresAt, time.Minute)
	assert.Equal(t, int64(10001), sess.User.TelegramUserId)
	assert.Equal(t, "Dara Sok", sess.User.DisplayName)
	assert.Equal(t, apigen.AppUserLocale("en"), sess.User.Locale)

	rec := e.do(t, http.MethodGet, "/api/app/me", nil, bearer(sess.Token))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var me apigen.AppUser
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	assert.Equal(t, sess.User, me)
}

func TestAppLoginTelegramRejectsTamperedInitData(t *testing.T) {
	e := newRunnerEnv(t)
	values, err := url.ParseQuery(runner.SignInitData(runnerBotToken, runner.TelegramUser{ID: 10001, FirstName: "Dara"}, time.Now()))
	require.NoError(t, err)
	values.Set("user", `{"id":10002,"first_name":"Dara"}`)

	rec := e.do(t, http.MethodPost, "/api/app/auth/telegram?lang=zh", map[string]string{"initData": values.Encode()}, nil)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	body := decodeRunnerError(t, rec)
	assert.Equal(t, apperr.CodeTelegramAuthInvalid, body.Error.Code)
	assert.Equal(t, e.catalog.T(i18n.ZH, apperr.CodeTelegramAuthInvalid, nil), body.Error.Message)
}

func TestAppMeRejectsMissingTokenAndStaffCookie(t *testing.T) {
	e := newRunnerEnv(t)
	ctx := context.Background()
	_, err := e.iam.CreateStaff(ctx, "ops.runner", "Ops Runner", iam.RoleOps, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	staffToken, _, err := e.iam.Login(ctx, "ops.runner", "Correct-Horse-Battery-9", httpx.Meta{IP: "127.0.0.1"})
	require.NoError(t, err)

	rec := e.do(t, http.MethodGet, "/api/app/me", nil, nil)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, apperr.CodeUnauthenticated, decodeRunnerError(t, rec).Error.Code)

	rec = e.do(t, http.MethodGet, "/api/app/me", nil, http.Header{"Cookie": []string{iam.CookieName + "=" + staffToken}})
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "员工 Cookie 不能访问跑者接口")

	rec = e.do(t, http.MethodGet, "/api/app/me", nil, bearer("not-a-real-token"))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestAdminMeRejectsRunnerBearerToken(t *testing.T) {
	e := newRunnerEnv(t)
	sess := e.loginRunner(t, 10001, "Dara Sok")

	rec := e.do(t, http.MethodGet, "/api/admin/me", nil, bearer(sess.Token))

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, apperr.CodeUnauthenticated, decodeRunnerError(t, rec).Error.Code)
}

func TestAppLogoutRevokesToken(t *testing.T) {
	e := newRunnerEnv(t)
	sess := e.loginRunner(t, 10001, "Dara Sok")

	rec := e.do(t, http.MethodPost, "/api/app/auth/logout", nil, bearer(sess.Token))
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	rec = e.do(t, http.MethodGet, "/api/app/me", nil, bearer(sess.Token))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
