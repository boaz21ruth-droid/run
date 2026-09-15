package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/iam"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/runner"
)

// paymentHTTPEnv 是凭证与审核 HTTP 测试共用的环境（Task 16、17 在此追加员工登录与 JSON 请求辅助函数）。
type paymentHTTPEnv struct {
	*paytest.Env
	router  http.Handler
	catalog *i18n.Catalog
}

func newPaymentHTTPEnv(t *testing.T) paymentHTTPEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	env := paytest.NewEnv(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:          logx.New("error", io.Discard),
		Catalog:      catalog,
		Pool:         env.Pool,
		IAM:          env.IAM,
		Events:       event.NewService(env.Pool),
		Runner:       env.Runners,
		Pricing:      env.Prices,
		Registration: env.Orders,
		Payment:      env.Payments,
		Env:          "dev",
	})
	return paymentHTTPEnv{Env: env, router: router, catalog: catalog}
}

func (e paymentHTTPEnv) staffCookie(t *testing.T, role iam.Role, username string) *http.Cookie {
	t.Helper()
	const password = "Correct-Horse-Battery-9"
	ctx := context.Background()
	_, err := e.IAM.CreateStaff(ctx, username, "HTTP "+string(role), role, password)
	require.NoError(t, err)
	token, _, err := e.IAM.Login(ctx, username, password, httpx.Meta{IP: "127.0.0.1", UserAgent: "payment-http-test"})
	require.NoError(t, err)
	return &http.Cookie{Name: iam.CookieName, Value: token}
}

// adminRequest 发 JSON 请求；非 GET 自动带 X-WeRun-Client: admin。
func (e paymentHTTPEnv) adminRequest(t *testing.T, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
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
	if method != http.MethodGet {
		req.Header.Set(httpx.HeaderClient, "admin")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func (e paymentHTTPEnv) runnerToken(t *testing.T, telegramID int64, name string) (string, runner.User) {
	t.Helper()
	initData := runner.SignInitData(paytest.BotToken, runner.TelegramUser{
		ID:           telegramID,
		FirstName:    name,
		Username:     fmt.Sprintf("runner%d", telegramID),
		LanguageCode: "en",
	}, e.Clock.Now())
	session, err := e.Runners.LoginTelegram(context.Background(), initData, httpx.Meta{IP: "127.0.0.1", UserAgent: "payment-http-test"})
	require.NoError(t, err)
	return session.Token, session.User
}

func (e paymentHTTPEnv) uploadProof(t *testing.T, orderNo string, body io.Reader, contentType, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/app/orders/"+orderNo+"/proofs", body)
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// proofForm 先写文本字段、最后写文件（file 为 nil 时不写文件）。
func proofForm(t *testing.T, file []byte, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, k := range slices.Sorted(maps.Keys(fields)) {
		require.NoError(t, w.WriteField(k, fields[k]))
	}
	if file != nil {
		fw, err := w.CreateFormFile("file", "receipt.png")
		require.NoError(t, err)
		_, err = fw.Write(file)
		require.NoError(t, err)
	}
	require.NoError(t, w.Close())
	return &buf, w.FormDataContentType()
}

func paymentDecode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &v), rec.Body.String())
	return v
}
