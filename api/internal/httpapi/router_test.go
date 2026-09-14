package httpapi_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func newRouter(t *testing.T, pool *pgxpool.Pool) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	return httpapi.NewRouter(httpapi.RouterDeps{
		Log:     slog.New(slog.DiscardHandler),
		Catalog: cat,
		Pool:    pool,
	})
}

func get(r http.Handler, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil))
	return rec
}

func TestHealthz(t *testing.T) {
	rec := get(newRouter(t, nil), "/api/healthz")

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	assert.NotEmpty(t, rec.Header().Get(httpx.HeaderRequestID))
}

func TestReadyzWithDatabase(t *testing.T) {
	rec := get(newRouter(t, dbtest.NewPool(t)), "/api/readyz")

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
}

func TestReadyzWhenDatabaseUnavailable(t *testing.T) {
	pool := dbtest.NewPool(t)
	pool.Close()

	rec := get(newRouter(t, pool), "/api/readyz")

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.JSONEq(t, `{"status":"unavailable"}`, rec.Body.String())
}

func TestUnknownRouteReturnsLocalizedNotFound(t *testing.T) {
	rec := get(newRouter(t, nil), "/api/nope?lang=zh")

	assert.Equal(t, http.StatusNotFound, rec.Code)
	var body httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "NOT_FOUND", body.Error.Code)
	assert.Equal(t, "找不到请求的内容。", body.Error.Message)
}

func TestClientIPTrustsOnlyPrivateProxies(t *testing.T) {
	r := newRouter(t, nil)
	r.GET("/test/client-ip", func(c *gin.Context) {
		c.String(http.StatusOK, httpx.MetaOf(c).IP)
	})
	clientIP := func(remoteAddr string) string {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/test/client-ip", nil)
		req.RemoteAddr = remoteAddr
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Body.String()
	}

	// 来自 compose 网络里的 Caddy：取 X-Forwarded-For 中的真实客户端
	assert.Equal(t, "203.0.113.9", clientIP("172.18.0.5:41234"))
	// 来自公网的直连请求：伪造的 X-Forwarded-For 不被采信
	assert.Equal(t, "198.51.100.7", clientIP("198.51.100.7:41234"))
}

func TestOversizedRequestBodyIsRejected(t *testing.T) {
	r := newRouter(t, nil)

	body := strings.NewReader(strings.Repeat("a", (1<<20)+1)) // 1 MiB + 1 字节
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/admin/auth/login", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(httpx.HeaderClient, "admin")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	var errBody httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &errBody))
	assert.Equal(t, apperr.CodeBadRequest, errBody.Error.Code)
}
