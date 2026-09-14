package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func serveError(t *testing.T, lang i18n.Lang, handlerErr error) (*httptest.ResponseRecorder, *bytes.Buffer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	var logBuf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logBuf, nil))

	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		c.Set("werun.lang", lang)
		c.Set("werun.request_id", "req-1")
		httpx.WriteError(c, cat, log, handlerErr)
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/x", nil)
	r.ServeHTTP(rec, req)
	return rec, &logBuf
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) httpx.ErrorBody {
	t.Helper()
	var body httpx.ErrorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

func TestWriteErrorRendersLocalizedFields(t *testing.T) {
	err := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
		WithField("slug", "field.too_long", map[string]any{"max": 60})

	rec, _ := serveError(t, i18n.ZH, err)

	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "VALIDATION_FAILED", body.Error.Code)
	assert.Equal(t, "请检查标出的字段。", body.Error.Message)
	assert.Equal(t, map[string]string{"slug": "不能超过 60 个字符。"}, body.Error.Fields)
}

func TestWriteErrorFindsWrappedAppError(t *testing.T) {
	err := fmt.Errorf("create event: %w", apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken))

	rec, _ := serveError(t, i18n.EN, err)

	assert.Equal(t, http.StatusConflict, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "EVENT_SLUG_TAKEN", body.Error.Code)
	assert.Equal(t, "This URL slug is already used by another event.", body.Error.Message)
	assert.Nil(t, body.Error.Fields)
}

func TestWriteErrorHidesUnknownErrors(t *testing.T) {
	rec, logBuf := serveError(t, i18n.EN, errors.New("boom: connection refused"))

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "INTERNAL", body.Error.Code)
	assert.NotContains(t, rec.Body.String(), "connection refused")
	assert.Contains(t, logBuf.String(), "connection refused")
	assert.Contains(t, logBuf.String(), "req-1")
}
