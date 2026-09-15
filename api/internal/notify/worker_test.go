package notify_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/logx"
)

type sentMessage struct {
	chatID int64
	text   string
	button *notify.Button
}

type fakeSender struct {
	err   error
	calls []sentMessage
}

func (f *fakeSender) Send(_ context.Context, chatID int64, text string, button *notify.Button) error {
	f.calls = append(f.calls, sentMessage{chatID: chatID, text: text, button: button})
	return f.err
}

type logState struct {
	status    string
	attempts  int16
	lastError *string
	sentAt    *time.Time
}

func insertPendingLog(t *testing.T, pool *pgxpool.Pool, key string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO notification_logs (channel, recipient, template, locale, entity_type, entity_id, dedupe_key)
		VALUES ('TELEGRAM', '42', 'order_expired', 'en', 'reg_order', 1, $1)
		RETURNING id`, key).Scan(&id))
	return id
}

func readLogState(t *testing.T, pool *pgxpool.Pool, id int64) logState {
	t.Helper()
	var s logState
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status, attempts, last_error, sent_at FROM notification_logs WHERE id = $1`, id).
		Scan(&s.status, &s.attempts, &s.lastError, &s.sentAt))
	return s
}

func sendJob(logID int64, attempt, maxAttempts int) *river.Job[notify.SendArgs] {
	return &river.Job[notify.SendArgs]{
		JobRow: &rivertype.JobRow{ID: 1, Attempt: attempt, MaxAttempts: maxAttempts},
		Args: notify.SendArgs{
			LogID:  logID,
			ChatID: 42,
			Text:   "hello",
			Button: &notify.Button{Text: "View order", URL: "https://app.werun.test/orders/WR1"},
		},
	}
}

func newSendWorker(pool *pgxpool.Pool, sender notify.Sender) *notify.SendWorker {
	return &notify.SendWorker{Pool: pool, Sender: sender, Log: logx.New("error", io.Discard)}
}

func TestSendWorkerMarksLogSent(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:sent")
	sender := &fakeSender{}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 1, 5))

	require.NoError(t, err)
	require.Equal(t, []sentMessage{{chatID: 42, text: "hello", button: &notify.Button{Text: "View order", URL: "https://app.werun.test/orders/WR1"}}}, sender.calls)
	state := readLogState(t, pool, logID)
	require.Equal(t, "SENT", state.status)
	require.Equal(t, int16(1), state.attempts)
	require.Nil(t, state.lastError)
	require.NotNil(t, state.sentAt)
}

func TestSendWorkerSkipsAlreadySentLog(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:already-sent")
	_, err := pool.Exec(context.Background(), `UPDATE notification_logs SET status = 'SENT', sent_at = now(), attempts = 1 WHERE id = $1`, logID)
	require.NoError(t, err)
	sender := &fakeSender{}

	err = newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 2, 5))

	require.NoError(t, err)
	require.Empty(t, sender.calls)
	require.Equal(t, int16(1), readLogState(t, pool, logID).attempts)
}

func TestSendWorkerBlockedRecipientFailsAndCancels(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:blocked")
	sender := &fakeSender{err: fmt.Errorf("%w: Forbidden: bot was blocked by the user", notify.ErrRecipientBlocked)}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 1, 5))

	var cancelErr *river.JobCancelError
	require.True(t, errors.As(err, &cancelErr), "403 必须返回 river.JobCancel，得到 %v", err)
	state := readLogState(t, pool, logID)
	require.Equal(t, "FAILED", state.status)
	require.Equal(t, int16(1), state.attempts)
	require.NotNil(t, state.lastError)
	require.Contains(t, *state.lastError, "blocked")
	require.Nil(t, state.sentAt)
}

func TestSendWorkerTransientErrorKeepsPendingAndCountsAttempts(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:transient")
	sender := &fakeSender{err: errors.New("telegram sendMessage: status 502: Bad Gateway")}
	worker := newSendWorker(pool, sender)

	err := worker.Work(context.Background(), sendJob(logID, 1, 5))

	require.ErrorContains(t, err, "status 502")
	var cancelErr *river.JobCancelError
	require.False(t, errors.As(err, &cancelErr), "临时错误要让 River 重试")
	state := readLogState(t, pool, logID)
	require.Equal(t, "PENDING", state.status)
	require.Equal(t, int16(1), state.attempts)
	require.NotNil(t, state.lastError)
	require.Contains(t, *state.lastError, "Bad Gateway")

	require.Error(t, worker.Work(context.Background(), sendJob(logID, 2, 5)))
	state = readLogState(t, pool, logID)
	require.Equal(t, "PENDING", state.status)
	require.Equal(t, int16(2), state.attempts)
}

func TestSendWorkerLastAttemptMarksFailed(t *testing.T) {
	pool := dbtest.NewPool(t)
	logID := insertPendingLog(t, pool, "worker:last-attempt")
	sender := &fakeSender{err: errors.New("telegram sendMessage: status 500: Internal Server Error")}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(logID, 5, 5))

	require.Error(t, err)
	state := readLogState(t, pool, logID)
	require.Equal(t, "FAILED", state.status)
	require.Equal(t, int16(1), state.attempts)
}

func TestSendWorkerMissingLogCancels(t *testing.T) {
	pool := dbtest.NewPool(t)
	sender := &fakeSender{}

	err := newSendWorker(pool, sender).Work(context.Background(), sendJob(999999, 1, 5))

	var cancelErr *river.JobCancelError
	require.True(t, errors.As(err, &cancelErr))
	require.Empty(t, sender.calls)
}
