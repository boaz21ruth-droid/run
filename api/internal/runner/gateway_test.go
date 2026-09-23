package runner_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/runner"
)

func gatewayServer(t *testing.T, status int, body string, capture *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/sendVerificationMessage", r.URL.Path)
		assert.Equal(t, "Bearer gw-token", r.Header.Get("Authorization"))
		if capture != nil {
			require.NoError(t, json.NewDecoder(r.Body).Decode(capture))
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

func TestGatewaySenderSuccess(t *testing.T) {
	var got map[string]any
	srv := gatewayServer(t, 200, `{"ok":true,"result":{"request_id":"req-1","delivery_status":{"status":"sent"}}}`, &got)
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, srv.Client())

	id, err := s.Send(context.Background(), "+85512345678", "482910")

	require.NoError(t, err)
	assert.Equal(t, "req-1", id)
	assert.Equal(t, "+85512345678", got["phone_number"])
	assert.Equal(t, "482910", got["code"])
	assert.Equal(t, float64(300), got["ttl"])
}

func TestGatewaySenderPhoneUnreachable(t *testing.T) {
	srv := gatewayServer(t, 200, `{"ok":false,"error":"PHONE_NUMBER_INVALID"}`, nil)
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, srv.Client())

	_, err := s.Send(context.Background(), "+85512345678", "482910")

	assert.True(t, errors.Is(err, runner.ErrPhoneUnreachable))
}

func TestGatewaySenderServerError(t *testing.T) {
	srv := gatewayServer(t, 502, `bad gateway`, nil)
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, srv.Client())

	_, err := s.Send(context.Background(), "+85512345678", "482910")

	require.Error(t, err)
	assert.False(t, errors.Is(err, runner.ErrPhoneUnreachable))
	assert.NotContains(t, err.Error(), "gw-token", "错误里不能带 token")
	assert.NotContains(t, err.Error(), "12345678", "错误里不能带完整手机号")
}

func TestGatewaySenderTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer srv.Close()
	s := runner.NewGatewaySender("gw-token", srv.URL, &http.Client{Timeout: 50 * time.Millisecond})

	_, err := s.Send(context.Background(), "+85512345678", "482910")

	require.Error(t, err)
}

func TestFixedAndLogSenders(t *testing.T) {
	id, err := runner.FixedOTPSender{}.Send(context.Background(), "+85512345678", "123456")
	require.NoError(t, err)
	assert.Empty(t, id)
}
