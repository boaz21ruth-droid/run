package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"time"
	_ "time/tzdata" // 运行镜像里不一定带时区库，把 Asia/Phnom_Penh 编进二进制

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// SessionRetention：过期或吊销超过这么久的会话才会被物理删除。
const SessionRetention = 7 * 24 * time.Hour

// SessionCleanupArgs 是会话清理任务的参数（无字段）。
type SessionCleanupArgs struct{}

// Kind 是 River 用来区分任务类型的名字。
func (SessionCleanupArgs) Kind() string { return "session_cleanup" }

// SessionCleaner 由 iam.Service 实现。
type SessionCleaner interface {
	DeleteExpiredSessions(ctx context.Context, olderThan time.Duration) (int64, error)
}

// SessionCleanupWorker 删除过期超过 SessionRetention 的会话。
type SessionCleanupWorker struct {
	river.WorkerDefaults[SessionCleanupArgs]
	Sessions SessionCleaner
	Log      *slog.Logger
}

// Work 执行一次清理；返回错误时 River 会按默认策略重试。
func (w *SessionCleanupWorker) Work(ctx context.Context, job *river.Job[SessionCleanupArgs]) error {
	deleted, err := w.Sessions.DeleteExpiredSessions(ctx, SessionRetention)
	if err != nil {
		return fmt.Errorf("delete expired sessions: %w", err)
	}
	w.Log.InfoContext(ctx, "session cleanup finished", "job_id", job.ID, "deleted", deleted)
	return nil
}

// NewClient 创建能执行任务的 River 客户端：注册全部 worker 与周期任务，默认队列 10 个并发。
func NewClient(pool *pgxpool.Pool, log *slog.Logger, sessions SessionCleaner) (*river.Client[pgx.Tx], error) {
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	if err != nil {
		return nil, fmt.Errorf("load Asia/Phnom_Penh: %w", err)
	}

	workers := river.NewWorkers()
	river.AddWorker(workers, &SessionCleanupWorker{Sessions: sessions, Log: log})

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger: log,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
		},
		Workers: workers,
		PeriodicJobs: []*river.PeriodicJob{
			river.NewPeriodicJob(
				DailyAt{Hour: 3, Minute: 0, Loc: phnomPenh},
				func() (river.JobArgs, *river.InsertOpts) { return SessionCleanupArgs{}, nil },
				&river.PeriodicJobOpts{ID: "session_cleanup"},
			),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create river client: %w", err)
	}
	return client, nil
}
