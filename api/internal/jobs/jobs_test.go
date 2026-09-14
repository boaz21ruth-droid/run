package jobs_test

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/require"

	"werun/api/internal/jobs"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/logx"
)

type fakeCleaner struct {
	calls   chan time.Duration
	deleted int64
	err     error
}

func newFakeCleaner() *fakeCleaner {
	return &fakeCleaner{calls: make(chan time.Duration, 10)}
}

func (f *fakeCleaner) DeleteExpiredSessions(_ context.Context, olderThan time.Duration) (int64, error) {
	select {
	case f.calls <- olderThan:
	default:
	}
	return f.deleted, f.err
}

func TestSessionCleanupArgsKind(t *testing.T) {
	require.Equal(t, "session_cleanup", jobs.SessionCleanupArgs{}.Kind())
}

func TestSessionCleanupWorkerDeletesSessionsOlderThanSevenDays(t *testing.T) {
	cleaner := newFakeCleaner()
	cleaner.deleted = 3
	worker := &jobs.SessionCleanupWorker{Sessions: cleaner, Log: logx.New("error", io.Discard)}

	err := worker.Work(context.Background(), &river.Job[jobs.SessionCleanupArgs]{
		JobRow: &rivertype.JobRow{ID: 42},
	})

	require.NoError(t, err)
	require.Equal(t, 7*24*time.Hour, <-cleaner.calls)
	require.Equal(t, 7*24*time.Hour, jobs.SessionRetention)
}

func TestSessionCleanupWorkerReturnsCleanerError(t *testing.T) {
	cleaner := newFakeCleaner()
	cleaner.err = errors.New("database is down")
	worker := &jobs.SessionCleanupWorker{Sessions: cleaner, Log: logx.New("error", io.Discard)}

	err := worker.Work(context.Background(), &river.Job[jobs.SessionCleanupArgs]{
		JobRow: &rivertype.JobRow{ID: 7},
	})

	require.ErrorContains(t, err, "database is down")
}

// 集成测试：真实 PostgreSQL + River，插入一条任务后，worker 必须把它取出来执行。
func TestClientRunsSessionCleanupJob(t *testing.T) {
	pool := dbtest.NewPool(t)
	cleaner := newFakeCleaner()

	client, err := jobs.NewClient(pool, logx.New("error", io.Discard), cleaner)
	require.NoError(t, err)

	ctx := context.Background()
	require.NoError(t, client.Start(ctx))
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})

	_, err = client.Insert(ctx, jobs.SessionCleanupArgs{}, nil)
	require.NoError(t, err)

	select {
	case olderThan := <-cleaner.calls:
		require.Equal(t, jobs.SessionRetention, olderThan)
	case <-time.After(15 * time.Second):
		t.Fatal("15 秒内 session_cleanup 任务没有被执行")
	}
}
