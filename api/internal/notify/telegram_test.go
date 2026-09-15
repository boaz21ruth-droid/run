package notify_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/platform/logx"
)

const testBotToken = "123456:test-token"

type capturedRequest struct {
	method      string
	path        string
	contentType string
	body        []byte
}

func telegramServer(t *testing.T, status int, response string) (*httptest.Server, <-chan capturedRequest) {
	t.Helper()
	captured := make(chan capturedRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		captured <- capturedRequest{method: r.Method, path: r.URL.Path, contentType: r.Header.Get("Content-Type"), body: body}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

func TestTelegramSenderSendsMessageWithWebAppButton(t *testing.T) {
	srv, captured := telegramServer(t, http.StatusOK, `{"ok":true,"result":{"message_id":1}}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "hello", &notify.Button{Text: "View order", URL: "https://app.werun.test/orders/WR1"})

	require.NoError(t, err)
	req := <-captured
	require.Equal(t, http.MethodPost, req.method)
	require.Equal(t, "/bot"+testBotToken+"/sendMessage", req.path)
	require.Equal(t, "application/json", req.contentType)
	require.JSONEq(t, `{
		"chat_id": 42,
		"text": "hello",
		"reply_markup": {"inline_keyboard": [[{"text": "View order", "web_app": {"url": "https://app.werun.test/orders/WR1"}}]]}
	}`, string(req.body))
}

func TestTelegramSenderOmitsReplyMarkupWithoutButton(t *testing.T) {
	srv, captured := telegramServer(t, http.StatusOK, `{"ok":true,"result":{}}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	require.NoError(t, sender.Send(context.Background(), 42, "hello", nil))

	require.JSONEq(t, `{"chat_id": 42, "text": "hello"}`, string((<-captured).body))
}

func TestTelegramSenderForbiddenIsRecipientBlocked(t *testing.T) {
	srv, _ := telegramServer(t, http.StatusForbidden, `{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "hello", nil)

	require.ErrorIs(t, err, notify.ErrRecipientBlocked)
	require.ErrorContains(t, err, "Forbidden: bot was blocked by the user")
}

func TestTelegramSenderBadRequestReturnsDescription(t *testing.T) {
	srv, _ := telegramServer(t, http.StatusBadRequest, `{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "hello", nil)

	require.Error(t, err)
	require.NotErrorIs(t, err, notify.ErrRecipientBlocked)
	require.ErrorContains(t, err, "status 400")
	require.ErrorContains(t, err, "Bad Request: chat not found")
}

func TestTelegramSenderOKFalseIsError(t *testing.T) {
	srv, _ := telegramServer(t, http.StatusOK, `{"ok":false,"description":"Bad Request: message text is empty"}`)
	sender := notify.NewTelegramSender(testBotToken, srv.URL, srv.Client())

	err := sender.Send(context.Background(), 42, "", nil)

	require.ErrorContains(t, err, "Bad Request: message text is empty")
}

func TestTelegramSenderNetworkErrorDoesNotLeakToken(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	baseURL := srv.URL
	srv.Close()
	sender := notify.NewTelegramSender(testBotToken, baseURL, nil)

	err := sender.Send(context.Background(), 42, "hello", nil)

	require.Error(t, err)
	require.NotContains(t, err.Error(), testBotToken)
}

func TestLogSenderNeverFails(t *testing.T) {
	sender := notify.LogSender{Log: logx.New("error", io.Discard)}

	require.NoError(t, sender.Send(context.Background(), 42, "hello", &notify.Button{Text: "View order", URL: "https://x"}))
}
