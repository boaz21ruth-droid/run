package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func newTestEngine(t *testing.T, logBuf *bytes.Buffer) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	log := slog.New(slog.NewJSONHandler(logBuf, nil))
	r := gin.New()
	r.Use(httpx.RequestID(), httpx.AccessLog(log), httpx.Recover(cat, log), httpx.Locale())
	return r
}

func TestRequestIDGeneratedWhenMissing(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var seen string
	r.GET("/x", func(c *gin.Context) { seen = httpx.RequestIDOf(c) })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil))

	assert.Regexp(t, regexp.MustCompile(`^[0-9a-f]{16}$`), seen)
	assert.Equal(t, seen, rec.Header().Get(httpx.HeaderRequestID))
}

func TestRequestIDKeepsValidIncomingAndReplacesInvalid(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var seen string
	r.GET("/x", func(c *gin.Context) { seen = httpx.RequestIDOf(c) })

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
	req.Header.Set(httpx.HeaderRequestID, "abc-123_XYZ")
	r.ServeHTTP(httptest.NewRecorder(), req)
	assert.Equal(t, "abc-123_XYZ", seen)

	bad := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
	bad.Header.Set(httpx.HeaderRequestID, "bad id!")
	r.ServeHTTP(httptest.NewRecorder(), bad)
	assert.NotEqual(t, "bad id!", seen)
	assert.Len(t, seen, 16)
}

func TestLocale(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var seen i18n.Lang
	r.GET("/x", func(c *gin.Context) { seen = httpx.LangOf(c) })

	cases := []struct {
		target, acceptLanguage string
		want                   i18n.Lang
	}{
		{"/x?lang=zh", "en-US", i18n.ZH},
		{"/x", "en-US,km;q=0.5", i18n.EN},
		{"/x", "", i18n.KM},
	}
	for _, c := range cases {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, c.target, nil)
		if c.acceptLanguage != "" {
			req.Header.Set("Accept-Language", c.acceptLanguage)
		}
		r.ServeHTTP(httptest.NewRecorder(), req)
		assert.Equal(t, c.want, seen, "target=%s accept=%s", c.target, c.acceptLanguage)
	}
}

func TestRecoverRendersInternalError(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	r.GET("/panic", func(c *gin.Context) { panic("kaboom") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/panic?lang=en", nil))

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	var body httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "INTERNAL", body.Error.Code)
	assert.Contains(t, logBuf.String(), "panic recovered")
	assert.Contains(t, logBuf.String(), "kaboom")
}

func TestAccessLogWritesRequestLine(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	r.GET("/teapot", func(c *gin.Context) { c.Status(http.StatusTeapot) })

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/teapot", nil))

	assert.Contains(t, logBuf.String(), `"msg":"http request"`)
	assert.Contains(t, logBuf.String(), `"path":"/teapot"`)
	assert.Contains(t, logBuf.String(), `"status":418`)
}

func TestMetaOfAndGin(t *testing.T) {
	var logBuf bytes.Buffer
	r := newTestEngine(t, &logBuf)
	var meta httpx.Meta
	var fromGin bool
	r.GET("/x", func(c *gin.Context) {
		meta = httpx.MetaOf(c)
		_, fromGin = httpx.Gin(c)
	})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
	req.Header.Set("User-Agent", "werun-test")
	req.Header.Set(httpx.HeaderRequestID, "req-meta")
	r.ServeHTTP(httptest.NewRecorder(), req)

	assert.True(t, fromGin)
	assert.Equal(t, httpx.Meta{RequestID: "req-meta", IP: "192.0.2.1", UserAgent: "werun-test"}, meta)

	_, ok := httpx.Gin(context.Background())
	assert.False(t, ok)
	assert.Equal(t, httpx.Meta{}, httpx.MetaOf(context.Background()))
}
