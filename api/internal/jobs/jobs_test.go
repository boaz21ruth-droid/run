package jobs_test

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/require"

	"werun/api/internal/jobs"
	"werun/api/internal/notify"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/logx"
	"werun/api/internal/registration"
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

	client, err := jobs.NewClient(jobs.Deps{Pool: pool, Log: logx.New("error", io.Discard), Sessions: cleaner})
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

// inserterProbeArgs 是只在测试里存在的任务类型：只入队客户端不认识任何 worker，也必须能插入。
type inserterProbeArgs struct {
	Note string `json:"note"`
}

func (inserterProbeArgs) Kind() string { return "inserter_probe" }

func TestInserterInsertsAnyJobKindInsideTransaction(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	inserter, err := jobs.NewInserter(pool)
	require.NoError(t, err)

	require.NoError(t, db.InTx(ctx, pool, func(tx pgx.Tx) error {
		res, err := inserter.InsertTx(ctx, tx, inserterProbeArgs{Note: "committed"}, &river.InsertOpts{MaxAttempts: 5})
		if err != nil {
			return err
		}
		require.NotZero(t, res.Job.ID)
		return nil
	}))

	rollback := errors.New("roll back on purpose")
	err = db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := inserter.InsertTx(ctx, tx, inserterProbeArgs{Note: "rolled back"}, nil); err != nil {
			return err
		}
		return rollback
	})
	require.ErrorIs(t, err, rollback)

	var count, maxAttempts int
	var state, args string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) OVER (), max_attempts, state::text, args::text FROM river_job WHERE kind = 'inserter_probe'`).
		Scan(&count, &maxAttempts, &state, &args))
	require.Equal(t, 1, count, "回滚的事务不留下任务")
	require.Equal(t, 5, maxAttempts)
	require.Equal(t, "available", state, "没有 worker 在跑，任务保持可执行状态")
	require.JSONEq(t, `{"note":"committed"}`, args)
}

type chanSender struct {
	sent chan string
}

func (s *chanSender) Send(_ context.Context, _ int64, text string, _ *notify.Button) error {
	s.sent <- text
	return nil
}

// 集成测试：注册了 Deps.Notify 的客户端必须执行 notify_send 并回写 SENT。
func TestClientRunsNotifySendJob(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	log := logx.New("error", io.Discard)
	var logID int64
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO notification_logs (channel, recipient, template, locale, entity_type, entity_id, dedupe_key)
		VALUES ('TELEGRAM', '42', 'order_expired', 'en', 'reg_order', 1, 'jobs-test:1')
		RETURNING id`).Scan(&logID))
	sender := &chanSender{sent: make(chan string, 1)}

	client, err := jobs.NewClient(jobs.Deps{
		Pool:     pool,
		Log:      log,
		Sessions: newFakeCleaner(),
		Notify:   &notify.SendWorker{Pool: pool, Sender: sender, Log: log},
	})
	require.NoError(t, err)
	require.NoError(t, client.Start(ctx))
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})

	_, err = client.Insert(ctx, notify.SendArgs{LogID: logID, ChatID: 42, Text: "hello"}, &river.InsertOpts{MaxAttempts: notify.SendMaxAttempts})
	require.NoError(t, err)

	select {
	case text := <-sender.sent:
		require.Equal(t, "hello", text)
	case <-time.After(15 * time.Second):
		t.Fatal("15 秒内 notify_send 任务没有被执行")
	}
	require.Eventually(t, func() bool {
		var status string
		return pool.QueryRow(ctx, `SELECT status FROM notification_logs WHERE id = $1`, logID).Scan(&status) == nil && status == "SENT"
	}, 10*time.Second, 100*time.Millisecond)
}

func TestNewClientRegistersDeadlineWorker(t *testing.T) {
	pool := dbtest.NewPool(t)
	log := logx.New("error", io.Discard)
	svc := registration.NewService(pool, nil, nil, notifytest.New(t, pool), time.Now)

	client, err := jobs.NewClient(jobs.Deps{
		Pool:     pool,
		Log:      log,
		Sessions: newFakeCleaner(),
		Deadline: &registration.DeadlineWorker{Svc: svc, Log: log},
	})
	require.NoError(t, err)

	// 客户端配置了 Workers：未注册的 kind 会返回 UnknownJobKindError。
	_, err = client.Insert(context.Background(), registration.DeadlineArgs{}, nil)
	require.NoError(t, err)
}
