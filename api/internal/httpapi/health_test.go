package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
)

func newHealthTestDeps(t *testing.T) RouterDeps {
	t.Helper()
	cat, err := i18n.LoadCatalog()
	require.NoError(t, err)
	return RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: cat,
		Pool:    dbtest.NewPool(t),
	}
}

func TestHealthHandlers_Healthz(t *testing.T) {
	h := NewHealthHandlers(nil)
	resp, err := h.GetHealthz(context.Background(), apigen.GetHealthzRequestObject{})
	require.NoError(t, err)
	assert.Equal(t, apigen.GetHealthz200JSONResponse{Status: "ok"}, resp)
}

func TestHealthHandlers_ReadyzOK(t *testing.T) {
	deps := newHealthTestDeps(t)
	resp, err := NewHealthHandlers(deps.Pool).GetReadyz(context.Background(), apigen.GetReadyzRequestObject{})
	require.NoError(t, err)
	assert.Equal(t, apigen.GetReadyz200JSONResponse{Status: "ok"}, resp)
}

func TestRouter_ReadyzUnavailableWhenPoolClosed(t *testing.T) {
	deps := newHealthTestDeps(t)
	deps.Pool.Close()
	router := NewRouter(deps)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/readyz", nil))

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	var body apigen.Health
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "unavailable", body.Status)
}

func TestRouter_HealthzThroughGeneratedHandler(t *testing.T) {
	router := NewRouter(newHealthTestDeps(t))

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/healthz", nil))

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	assert.NotEmpty(t, rec.Header().Get("X-Request-ID"))
}

func TestServerImplementsStrictInterface(t *testing.T) {
	var _ apigen.StrictServerInterface = (*Server)(nil)
}
