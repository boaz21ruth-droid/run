package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"werun/api/internal/notify/store"
)

const maxLastErrorBytes = 1000

// SendWorker 执行 notify_send：发送并回写 notification_logs。
type SendWorker struct {
	river.WorkerDefaults[SendArgs]
	Pool   *pgxpool.Pool
	Sender Sender
	Log    *slog.Logger
}

// Work 发送一条推送。已 SENT 的记录直接返回；403 写 FAILED 并取消任务；
// 其他错误 attempts+1、写 last_error 并返回错误让 River 重试，最后一次尝试失败时写 FAILED。
func (w *SendWorker) Work(ctx context.Context, job *river.Job[SendArgs]) error {
	q := store.New(w.Pool)
	row, err := q.GetNotificationLog(ctx, job.Args.LogID)
	if errors.Is(err, pgx.ErrNoRows) {
		return river.JobCancel(fmt.Errorf("notify: notification log %d not found", job.Args.LogID))
	}
	if err != nil {
		return fmt.Errorf("notify: load notification log %d: %w", job.Args.LogID, err)
	}
	if row.Status == StatusSent {
		return nil
	}

	sendErr := w.Sender.Send(ctx, job.Args.ChatID, job.Args.Text, job.Args.Button)
	if sendErr == nil {
		sentAt := time.Now()
		if err := q.MarkNotificationSent(ctx, store.MarkNotificationSentParams{ID: row.ID, SentAt: &sentAt}); err != nil {
			// 消息已发出但回写失败：返回错误会重试并可能重复发送，比丢失状态更可接受。
			return fmt.Errorf("notify: mark log %d sent: %w", row.ID, err)
		}
		w.Log.InfoContext(ctx, "notification sent", "log_id", row.ID, "job_id", job.ID)
		return nil
	}

	blocked := errors.Is(sendErr, ErrRecipientBlocked)
	status := StatusPending
	if blocked || job.Attempt >= job.MaxAttempts {
		status = StatusFailed
	}
	lastError := truncateError(sendErr)
	if err := q.MarkNotificationAttemptFailed(ctx, store.MarkNotificationAttemptFailedParams{
		ID:        row.ID,
		Status:    status,
		LastError: &lastError,
	}); err != nil {
		return errors.Join(sendErr, fmt.Errorf("notify: record failure for log %d: %w", row.ID, err))
	}

	if blocked {
		w.Log.WarnContext(ctx, "notification recipient blocked the bot", "log_id", row.ID, "job_id", job.ID)
		return river.JobCancel(sendErr)
	}
	w.Log.WarnContext(ctx, "notification send failed", "log_id", row.ID, "job_id", job.ID,
		"attempt", job.Attempt, "max_attempts", job.MaxAttempts, "error", lastError)
	return fmt.Errorf("notify: send log %d: %w", row.ID, sendErr)
}

func truncateError(err error) string {
	s := err.Error()
	if len(s) > maxLastErrorBytes {
		s = s[:maxLastErrorBytes]
	}
	return strings.ToValidUTF8(s, "")
}
