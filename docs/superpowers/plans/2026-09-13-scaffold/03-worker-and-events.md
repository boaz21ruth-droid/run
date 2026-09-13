# 03 · River 任务与赛事模块（Task 9–10）

> 全局约束、版本、跨任务契约（C1–C16）见 `00-overview.md`，本文件的每个任务都隐含遵守那里的内容。

**前置状态**：Task 1–8 已按契约完成：
- `apigen` 已生成健康检查与后台登录相关操作；
- `iam.Service`、`iam.Handlers`、`httpapi.AuthMiddleware` 可用；
- `App` 有 `Cfg`、`Log`、`Catalog`、`Pool`、`IAM` 字段；
- `RouterDeps` 有 `Log`、`Catalog`、`Pool`、`Server`、`IAM`、`Env` 字段；
- `api/sqlc.yaml` 已有 iam 块。

**本文件依赖、但 00-overview 没有写死的名字**：执行前先用下面的命令核对。如果实际名字不同，本文件代码里的调用点要跟着改成实际名字。

```bash
cd api
grep -n "func NewHealthHandlers" internal/httpapi/*.go   # Task 5：func NewHealthHandlers(pool *pgxpool.Pool) *HealthHandlers
grep -n "func NewServer" internal/httpapi/*.go           # Task 5/8：func NewServer(d RouterDeps) *Server；Task 8 用别名 type IAMHandlers = iam.Handlers 嵌入
grep -n "func NewHandlers" internal/iam/*.go             # Task 8：func NewHandlers(svc *Service, secureCookie bool) *Handlers
grep -n "func run(" cmd/werun/main.go                    # Task 4：func run(ctx context.Context, args []string, stdout, stderr io.Writer) int，分支形如 return runServe(ctx, args[1:], stderr)
grep -n "func runServe" cmd/werun/*.go                   # Task 4：func runServe(ctx context.Context, args []string, stderr io.Writer) int，内部用 signal.NotifyContext 监听 SIGINT/SIGTERM
```

---

### Task 9: River 客户端、会话清理定时任务、`serve --with-worker` 与 `werun worker`

**Files:**
- Create: `api/internal/jobs/schedule.go`
- Create: `api/internal/jobs/schedule_test.go`
- Create: `api/internal/jobs/jobs.go`
- Create: `api/internal/jobs/jobs_test.go`
- Create: `api/cmd/werun/router.go`
- Create: `api/cmd/werun/worker.go`
- Modify（整文件替换）: `api/cmd/werun/serve.go`
- Modify: `api/cmd/werun/main.go`（子命令分发加 `worker`）

**Interfaces:**
- Consumes:
  - `dbtest.NewPool(t testing.TB) *pgxpool.Pool`（C6，模板库已执行 `migrate.Up`，包含 River 的表）
  - `logx.New(level string, w io.Writer) *slog.Logger`（C2）
  - `(*iam.Service).DeleteExpiredSessions(ctx, olderThan time.Duration) (int64, error)`（C9）
  - `Bootstrap(ctx) (*App, error)`、`(*App).Close()`（C12）
  - `migrate.Up(ctx, pool, log) error`（C6）
  - `httpapi.NewRouter(httpapi.RouterDeps) *gin.Engine`（C12）
- Produces（C13）:
  - `jobs.SessionCleanupArgs`，`Kind() == "session_cleanup"`
  - `jobs.SessionCleaner` 接口
  - `jobs.SessionCleanupWorker{Sessions, Log}`
  - `jobs.DailyAt{Hour, Minute, Loc}.Next(time.Time) time.Time`
  - `jobs.SessionRetention = 7 * 24 * time.Hour`
  - `jobs.NewClient(pool, log, sessions) (*river.Client[pgx.Tx], error)`
  - 命令行：`werun serve --with-worker`、`werun worker`
  - `cmd/werun/router.go`：`func newRouter(app *App) *gin.Engine`（Task 10 会修改它）

已核对的 River v0.47.0 接口：
- `PeriodicJobConstructor` 是 `func() (river.JobArgs, *river.InsertOpts)`。
- `(*Client).Insert(ctx, args, *InsertOpts)` 不要求客户端已启动。
- `Start` 要求 `Queues` 和 `Workers` 都配置了。
- `Stop(ctx)` 是优雅停止，会等正在执行的任务结束；传给 `Start` 的 ctx 一旦被取消，就会变成硬停止。所以 `Start` 要传 `context.WithoutCancel(ctx)`，让优雅停止完全由 `Stop` 控制。
- `river.Job[T]` 嵌入了 `*rivertype.JobRow`，任务 ID 通过 `job.ID` 取。

- [ ] **Step 1: 写 DailyAt 的失败测试**

创建 `api/internal/jobs/schedule_test.go`：

```go
package jobs_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/jobs"
)

func TestDailyAtNext(t *testing.T) {
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	require.NoError(t, err)
	at3 := jobs.DailyAt{Hour: 3, Minute: 0, Loc: phnomPenh}

	cases := []struct {
		name    string
		sched   jobs.DailyAt
		current string
		want    string
	}{
		{"金边 02:59，排到当天 03:00", at3, "2026-09-13T19:59:00Z", "2026-09-13T20:00:00Z"},
		{"金边正好 03:00，排到第二天", at3, "2026-09-13T20:00:00Z", "2026-09-14T20:00:00Z"},
		{"金边 03:00:01，排到第二天", at3, "2026-09-13T20:00:01Z", "2026-09-14T20:00:00Z"},
		{"金边 23:30（UTC 仍是同一天），排到次日 03:00", at3, "2026-09-13T16:30:00Z", "2026-09-13T20:00:00Z"},
		{"月底跨月", at3, "2026-09-30T21:00:00Z", "2026-10-01T20:00:00Z"},
		{"年底跨年", at3, "2026-12-31T20:30:00Z", "2027-01-01T20:00:00Z"},
		{"Loc 为空时按 UTC", jobs.DailyAt{Hour: 3}, "2026-09-13T02:00:00Z", "2026-09-13T03:00:00Z"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current, err := time.Parse(time.RFC3339, tc.current)
			require.NoError(t, err)
			want, err := time.Parse(time.RFC3339, tc.want)
			require.NoError(t, err)

			got := tc.sched.Next(current)

			require.Truef(t, got.Equal(want), "got %s, want %s", got.UTC().Format(time.RFC3339), tc.want)
			require.True(t, got.After(current), "Next 必须严格晚于 current")
		})
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && go test ./internal/jobs/ -run TestDailyAtNext -v`
Expected: 编译失败，报 `undefined: jobs.DailyAt`（或 `no non-test Go files in .../internal/jobs`）。

- [ ] **Step 3: 实现 DailyAt**

创建 `api/internal/jobs/schedule.go`：

```go
// Package jobs 定义后台任务（River）以及它们的调度方式。
package jobs

import "time"

// DailyAt 是 River 的 PeriodicSchedule：每天在 Loc 时区的 Hour:Minute 触发一次。
type DailyAt struct {
	Hour, Minute int
	Loc          *time.Location
}

// Next 返回严格晚于 current 的下一个触发时刻。
func (d DailyAt) Next(current time.Time) time.Time {
	loc := d.Loc
	if loc == nil {
		loc = time.UTC
	}
	local := current.In(loc)
	next := time.Date(local.Year(), local.Month(), local.Day(), d.Hour, d.Minute, 0, 0, loc)
	if !next.After(local) {
		// time.Date 会自动把 Day+1 规范化到下个月或下一年
		next = time.Date(local.Year(), local.Month(), local.Day()+1, d.Hour, d.Minute, 0, 0, loc)
	}
	return next
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd api && go test ./internal/jobs/ -run TestDailyAtNext -v`
Expected: `--- PASS: TestDailyAtNext`，7 个子测试全部 PASS。

- [ ] **Step 5: 写会话清理任务与客户端的失败测试**

创建 `api/internal/jobs/jobs_test.go`：

```go
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
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `cd api && go test ./internal/jobs/ -v`
Expected: 编译失败，报 `undefined: jobs.SessionCleanupArgs`、`undefined: jobs.SessionCleanupWorker`、`undefined: jobs.NewClient`。

- [ ] **Step 7: 实现任务与客户端**

创建 `api/internal/jobs/jobs.go`：

```go
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
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `cd api && go mod tidy && go test ./internal/jobs/ -v`（需要本机 Docker 在运行，集成测试用 testcontainers）
Expected: `TestDailyAtNext`、`TestSessionCleanupArgsKind`、`TestSessionCleanupWorkerDeletesSessionsOlderThanSevenDays`、`TestSessionCleanupWorkerReturnsCleanerError`、`TestClientRunsSessionCleanupJob` 全部 PASS；`ok  werun/api/internal/jobs`。

- [ ] **Step 9: 提交 jobs 包**

```bash
git add api/internal/jobs api/go.mod api/go.sum
git commit -m "$(cat <<'EOF'
feat(api): add River client with daily session cleanup job

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

- [ ] **Step 10: 把路由装配抽到 `router.go`**

`serve.go` 接下来会整文件替换。为了不丢掉 Task 5/8 的路由装配，先把它挪到一个独立函数。

创建 `api/cmd/werun/router.go`。Task 8 在 `serve.go` 的 `http.Server{Handler: httpapi.NewRouter(...)}` 里直接装配路由，这里把它挪成独立函数：

```go
package main

import (
	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi"
)

// newRouter 装配 HTTP 路由。serve 命令与测试共用这一处装配逻辑。
// httpapi.NewRouter 在 RouterDeps.Server 为 nil 时自己调用 NewServer 构造全部 handler。
func newRouter(app *App) *gin.Engine {
	return httpapi.NewRouter(httpapi.RouterDeps{
		Log:     app.Log,
		Catalog: app.Catalog,
		Pool:    app.Pool,
		IAM:     app.IAM,
		Env:     app.Cfg.Env,
	})
}
```

- [ ] **Step 11: 整文件替换 `serve.go`，加入 `--with-worker`**

把 `api/cmd/werun/serve.go` 的全部内容替换为（签名保持 Task 4 的 `runServe(ctx, args, stderr) int`）：

```go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"werun/api/internal/jobs"
	"werun/api/internal/platform/migrate"
)

// shutdownTimeout：收到 SIGTERM 后，等待进行中的请求与任务的最长时间。
const shutdownTimeout = 30 * time.Second

// runServe 启动 HTTP 服务；--with-worker 时在同一进程内运行 River worker。
func runServe(ctx context.Context, args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	autoMigrate := flags.Bool("auto-migrate", false, "启动前执行数据库迁移（只用于本地开发）")
	withWorker := flags.Bool("with-worker", false, "在同一进程内运行后台任务 worker")
	if err := flags.Parse(args); err != nil {
		return 2
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	app, err := Bootstrap(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "bootstrap: %v\n", err)
		return 1
	}
	defer app.Close()

	if *autoMigrate {
		if err := migrate.Up(ctx, app.Pool, app.Log); err != nil {
			app.Log.Error("auto migrate failed", "error", err)
			return 1
		}
	}

	var riverClient *river.Client[pgx.Tx]
	if *withWorker {
		riverClient, err = jobs.NewClient(app.Pool, app.Log, app.IAM)
		if err != nil {
			app.Log.Error("create river client failed", "error", err)
			return 1
		}
		// 不把会被信号取消的 ctx 传给 Start：取消它会让 River 硬停止。优雅停止统一走 riverClient.Stop。
		if err := riverClient.Start(context.WithoutCancel(ctx)); err != nil {
			app.Log.Error("start river client failed", "error", err)
			return 1
		}
		app.Log.Info("river worker started")
	}

	if app.Cfg.IsProd() {
		gin.SetMode(gin.ReleaseMode)
	}
	srv := &http.Server{
		Addr:              app.Cfg.HTTPAddr,
		Handler:           newRouter(app),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		app.Log.Info("http server listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
		close(serveErr)
	}()

	exitCode := 0
	select {
	case err := <-serveErr:
		if err != nil {
			app.Log.Error("http server failed", "error", err)
			exitCode = 1
		}
	case <-ctx.Done():
		app.Log.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		app.Log.Error("graceful shutdown failed", "error", err)
		exitCode = 1
	}
	if riverClient != nil {
		if err := riverClient.Stop(shutdownCtx); err != nil {
			app.Log.Error("river stop failed", "error", err)
			exitCode = 1
		}
		app.Log.Info("river worker stopped")
	}
	return exitCode
}
```

- [ ] **Step 12: 新增 `werun worker` 子命令**

创建 `api/cmd/werun/worker.go`：

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"werun/api/internal/jobs"
)

// runWorker 只运行 River worker，不提供 HTTP。以后 worker 拆成独立容器时使用。
func runWorker(ctx context.Context, args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("worker", flag.ContinueOnError)
	flags.SetOutput(stderr)
	if err := flags.Parse(args); err != nil {
		return 2
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	app, err := Bootstrap(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "bootstrap: %v\n", err)
		return 1
	}
	defer app.Close()

	client, err := jobs.NewClient(app.Pool, app.Log, app.IAM)
	if err != nil {
		app.Log.Error("create river client failed", "error", err)
		return 1
	}
	if err := client.Start(context.WithoutCancel(ctx)); err != nil {
		app.Log.Error("start river client failed", "error", err)
		return 1
	}
	app.Log.Info("river worker started")

	<-ctx.Done()
	app.Log.Info("shutdown signal received")

	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := client.Stop(stopCtx); err != nil {
		app.Log.Error("river stop failed", "error", err)
		return 1
	}
	app.Log.Info("river worker stopped")
	return 0
}
```

修改 `api/cmd/werun/main.go`：
- 在 `run` 函数 `switch` 的 `case "serve":` 分支后面加一个分支：

```go
	case "worker":
		return runWorker(ctx, args[1:], stderr)
```

- 在 `usage` 常量里把 `serve` 那一行改为下面第一行，并在其下加入第二行：

```
  serve        启动 HTTP 服务（--auto-migrate：启动前执行迁移，只用于本地开发；--with-worker：同一进程运行后台任务）
  worker       只运行后台任务 worker
```

- [ ] **Step 13: 编译并跑全部测试**

Run: `cd api && go build ./... && go vet ./... && go test ./...`
Expected: 编译通过，所有包 `ok`。

- [ ] **Step 14: 本地冒烟验证**

本地 compose 要到 Task 16 才有，这里先临时起一个 PostgreSQL，端口和 `.env.example` 里的 `55432` 一致：

```bash
docker run -d --name werun-pg-task9 -e POSTGRES_USER=werun -e POSTGRES_PASSWORD=werun -e POSTGRES_DB=werun -p 55432:5432 postgres:16-alpine
cd api && set -a && . ../.env && set +a && go run ./cmd/werun serve --auto-migrate --with-worker
```

Expected：
1. 日志依次出现 `"msg":"river worker started"` 和 `"msg":"http server listening"`。
2. 另开一个终端执行 `curl -s http://127.0.0.1:8080/api/healthz`，输出 `{"status":"ok"}`。
3. 在服务终端按 Ctrl+C，日志出现 `"msg":"shutdown signal received"` 和 `"msg":"river worker stopped"`，进程以 0 退出。

再验证 `werun worker`：执行 `go run ./cmd/werun worker`，日志出现 `river worker started`；按 Ctrl+C 后出现 `river worker stopped`。

清理临时容器：`docker rm -f werun-pg-task9`

- [ ] **Step 15: 提交命令行接入**

```bash
cd api && go tool golangci-lint run ./... && cd ..
git add api/cmd/werun
git commit -m "$(cat <<'EOF'
feat(api): run River worker via serve --with-worker and worker command

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

---
### Task 10: 赛事模块（校验、存储、服务、接口）

**Files:**
- Create: `api/internal/event/model.go`
- Create: `api/internal/event/validate.go`
- Create: `api/internal/event/validate_test.go`
- Create: `api/db/queries/event.sql`
- Modify（整文件替换）: `api/sqlc.yaml`（在 iam 块后追加 event 块）
- Generate: `api/internal/event/store/`（sqlc）
- Create: `api/internal/event/service.go`
- Create: `api/internal/event/service_test.go`
- Modify: `api/openapi/openapi.yaml`（新增 5 个操作与 9 个 schema）
- Generate: `api/internal/httpapi/apigen/api.gen.go`、`api/internal/httpapi/apigen/permissions.gen.go`
- Create: `api/internal/event/handlers.go`
- Modify（整文件替换）: `api/internal/httpapi/server.go`
- Modify: `api/internal/httpapi/router.go`（`RouterDeps` 增加 `Events`）
- Create: `api/internal/httpapi/events_http_test.go`
- Modify（整文件替换）: `api/cmd/werun/router.go`
- Modify: `api/cmd/werun/app.go`（App 增加 `Events`）

**Interfaces:**
- Consumes:
  - `apperr.New / WithField / WithParams / As / FromPG / RegisterConstraint`，以及 `apperr.Code*` 常量（C3）
  - `i18n.Text`、`Text.In`、`i18n.ZH/EN/KM`、`(*Catalog).T`（C4）
  - `httpx.LangOf`、`httpx.MetaOf`、`httpx.Meta`、`httpx.HeaderClient`、`httpx.ErrorBody`（C5）
  - `db.InTx`（C6）、`dbtest.NewPool`（C6）
  - `audit.Record`、`audit.Entry`（C10）
  - `iam.Staff`、`iam.Role*`、`iam.StaffFrom`、`iam.NewService`、`iam.NewLoginLimiter`、`(*iam.Service).CreateStaff/Login`、`iam.CookieName`（C8、C9）
  - `httpapi.NewRouter`、`httpapi.RouterDeps`、`httpapi.NewHealthHandlers`、`iam.NewHandlers`（C12，以及本文件开头核对的名字）
- Produces（C11）:
  - `event.Category`、`event.Event`、`event.CategoryInput`、`event.CreateInput`
  - 常量 `event.StatusDraft="DRAFT"`、`event.StatusPublished="PUBLISHED"`、`event.TypeRace="RACE"`、`event.TypeFreeActivity="FREE_ACTIVITY"`、`event.OrganizerOfficial="OFFICIAL"`、`event.OrganizerPartner="PARTNER"`
  - `event.ValidateCreate(CreateInput) error`、`event.ValidateForPublish(Event) error`
  - `event.NewService(*pgxpool.Pool) *Service`，以及 `Create`、`Publish`、`ListAll`、`ListPublic`、`GetPublic`
  - `event.NewHandlers(*Service) *Handlers`：实现 `ListPublicEvents`、`GetPublicEvent`、`AdminListEvents`、`AdminCreateEvent`、`AdminPublishEvent`
  - `type httpapi.EventHandlers = event.Handlers`；`httpapi.RouterDeps` 新增 `Events *event.Service`；`httpapi.NewServer(d RouterDeps)` 构造 `EventHandlers`
  - `App.Events *event.Service`
  - OpenAPI 操作：`listPublicEvents`、`getPublicEvent`、`adminListEvents`、`adminCreateEvent`、`adminPublishEvent`（C7）

**`server.go` 为什么要整文件替换**

C12 写的是 `Server` 同时嵌入 `*iam.Handlers` 和 `*event.Handlers`。这两个类型名都叫 `Handlers`，Go 会报 `duplicate field Handlers`，编译不过。

本任务的做法：
- 沿用 Task 8 的做法：`server.go` 用导出的类型别名嵌入模块 handler（`type IAMHandlers = iam.Handlers`、`type EventHandlers = event.Handlers`），`NewServer(d RouterDeps)` 从路由依赖构造全部 handler；`RouterDeps` 新增 `Events *event.Service`。测试和命令行都只传 `RouterDeps`，不直接构造 `Server`。

**数据库事实**（`api/db/migrations/0002_events.sql`）：
- `events.status` 默认 `'DRAFT'`，有 `CHECK (status = 'DRAFT' OR published_at IS NOT NULL)`。
- `public_visible`、`registration_open` 默认 `false`。
- `slug UNIQUE`，约束名 `events_slug_key`。
- `event_categories` 有 `UNIQUE (event_id, code)`，约束名 `event_categories_event_id_code_key`。
- `distance_m > 0`，`capacity >= 0`，`start_at` 与 `cutoff_at` 可空。

- [ ] **Step 1: 写校验的失败测试**

创建 `api/internal/event/validate_test.go`：

```go
package event_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

func ptrTime(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func validInput() event.CreateInput {
	return event.CreateInput{
		Slug:          "pphm-2026",
		EventType:     event.TypeRace,
		OrganizerType: event.OrganizerOfficial,
		Name: i18n.Text{
			i18n.ZH: "金边半程马拉松 2026",
			i18n.EN: "Phnom Penh Half Marathon 2026",
			i18n.KM: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
		},
		City:     "Phnom Penh",
		RaceDate: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
		Categories: []event.CategoryInput{{
			Code: "21K",
			Name: i18n.Text{
				i18n.ZH: "半程 21K",
				i18n.EN: "Half Marathon 21K",
				i18n.KM: "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K",
			},
			DistanceM: 21097,
			Capacity:  800,
			StartAt:   ptrTime("2026-11-15T06:00:00+07:00"),
			CutoffAt:  ptrTime("2026-11-15T09:30:00+07:00"),
		}},
	}
}

// fieldKeys 取出 *apperr.Error 的"字段 → 文案 key"。
func fieldKeys(t *testing.T, err error) map[string]string {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	out := make(map[string]string, len(ae.Fields))
	for field, fe := range ae.Fields {
		out[field] = fe.Key
	}
	return out
}

func TestValidateCreateAcceptsValidInput(t *testing.T) {
	require.NoError(t, event.ValidateCreate(validInput()))
}

func TestValidateCreateAllowsCategoryWithoutTimes(t *testing.T) {
	in := validInput()
	in.Categories[0].StartAt = nil
	in.Categories[0].CutoffAt = nil
	require.NoError(t, event.ValidateCreate(in))
}

func TestValidateCreateRejectsInvalidInput(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(in *event.CreateInput)
		field  string
		key    string
	}{
		{"slug 为空", func(in *event.CreateInput) { in.Slug = "" }, "slug", "field.required"},
		{"slug 超过 60 个字符", func(in *event.CreateInput) { in.Slug = strings.Repeat("a", 61) }, "slug", "field.too_long"},
		{"slug 含大写字母", func(in *event.CreateInput) { in.Slug = "PPHM-2026" }, "slug", "field.slug_format"},
		{"slug 以连字符结尾", func(in *event.CreateInput) { in.Slug = "pphm-" }, "slug", "field.slug_format"},
		{"eventType 不在枚举内", func(in *event.CreateInput) { in.EventType = "MARATHON" }, "eventType", "field.invalid"},
		{"organizerType 不在枚举内", func(in *event.CreateInput) { in.OrganizerType = "SPONSOR" }, "organizerType", "field.invalid"},
		{"缺高棉文名称", func(in *event.CreateInput) { delete(in.Name, i18n.KM) }, "name.km", "field.required"},
		{"中文名称只有空格", func(in *event.CreateInput) { in.Name[i18n.ZH] = "   " }, "name.zh", "field.required"},
		{"city 为空", func(in *event.CreateInput) { in.City = "" }, "city", "field.required"},
		{"raceDate 为零值", func(in *event.CreateInput) { in.RaceDate = time.Time{} }, "raceDate", "field.required"},
		{"组别代码含小写", func(in *event.CreateInput) { in.Categories[0].Code = "21k" }, "categories[0].code", "field.category_code_format"},
		{"组别缺英文名称", func(in *event.CreateInput) { delete(in.Categories[0].Name, i18n.EN) }, "categories[0].name.en", "field.required"},
		{"距离为 0", func(in *event.CreateInput) { in.Categories[0].DistanceM = 0 }, "categories[0].distanceM", "field.must_be_positive"},
		{"名额为 0", func(in *event.CreateInput) { in.Categories[0].Capacity = 0 }, "categories[0].capacity", "field.must_be_positive"},
		{"关门时间早于发枪时间", func(in *event.CreateInput) {
			in.Categories[0].CutoffAt = ptrTime("2026-11-15T05:00:00+07:00")
		}, "categories[0].cutoffAt", "field.cutoff_before_start"},
		{"同一请求内组别代码重复", func(in *event.CreateInput) {
			in.Categories = append(in.Categories, in.Categories[0])
		}, "categories[1].code", apperr.CodeEventCategoryCodeTaken},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validInput()
			tc.mutate(&in)

			err := event.ValidateCreate(in)

			require.Error(t, err)
			ae, ok := apperr.As(err)
			require.True(t, ok)
			require.Equal(t, apperr.CodeValidation, ae.Code)
			require.Equal(t, http.StatusUnprocessableEntity, ae.Status)
			require.Equal(t, tc.key, fieldKeys(t, err)[tc.field], "fields=%v", fieldKeys(t, err))
		})
	}
}

func publishable() event.Event {
	return event.Event{
		ID:     1,
		Slug:   "pphm-2026",
		Status: event.StatusDraft,
		Categories: []event.Category{{
			Code:     "21K",
			Capacity: 800,
			StartAt:  ptrTime("2026-11-15T06:00:00+07:00"),
			CutoffAt: ptrTime("2026-11-15T09:30:00+07:00"),
		}},
	}
}

func TestValidateForPublish(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(e *event.Event)
		code    string
		status  int
		missing string
	}{
		{"完整的草稿可以发布", func(e *event.Event) {}, "", 0, ""},
		{"已经发布", func(e *event.Event) { e.Status = event.StatusPublished }, apperr.CodeEventAlreadyPublished, http.StatusConflict, ""},
		{"没有组别", func(e *event.Event) { e.Categories = nil }, apperr.CodeEventNoCategory, http.StatusUnprocessableEntity, ""},
		{"缺发枪与关门时间", func(e *event.Event) {
			e.Categories[0].StartAt = nil
			e.Categories[0].CutoffAt = nil
		}, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: start_at, cutoff_at"},
		{"名额为 0", func(e *event.Event) { e.Categories[0].Capacity = 0 }, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: capacity"},
		{"关门时间早于发枪时间", func(e *event.Event) {
			e.Categories[0].CutoffAt = ptrTime("2026-11-15T05:00:00+07:00")
		}, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: cutoff_before_start"},
		{"多个组别不完整", func(e *event.Event) {
			e.Categories[0].StartAt = nil
			e.Categories = append(e.Categories, event.Category{Code: "10K", Capacity: 1200})
		}, apperr.CodeEventCategoryIncomplete, http.StatusUnprocessableEntity, "21K: start_at; 10K: start_at, cutoff_at"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := publishable()
			tc.mutate(&e)

			err := event.ValidateForPublish(e)

			if tc.code == "" {
				require.NoError(t, err)
				return
			}
			ae, ok := apperr.As(err)
			require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
			require.Equal(t, tc.code, ae.Code)
			require.Equal(t, tc.status, ae.Status)
			if tc.missing != "" {
				require.Equal(t, "field.category_incomplete", ae.Fields["categories"].Key)
				require.Equal(t, tc.missing, ae.Fields["categories"].Params["missing"])
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd api && go test ./internal/event/ -run 'TestValidate' -v`
Expected: 编译失败，报 `undefined: event.CreateInput`、`undefined: event.ValidateCreate` 等。

- [ ] **Step 3: 实现模型与校验**

创建 `api/internal/event/model.go`：

```go
// Package event 是赛事模块：赛事与组别的创建、发布、公开查询。
package event

import (
	"time"

	"werun/api/internal/platform/i18n"
)

const (
	StatusDraft     = "DRAFT"
	StatusPublished = "PUBLISHED"

	TypeRace         = "RACE"
	TypeFreeActivity = "FREE_ACTIVITY"

	OrganizerOfficial = "OFFICIAL"
	OrganizerPartner  = "PARTNER"
)

// Category 是赛事下的组别（21K / 10K / 5K）。
type Category struct {
	ID        int64
	Code      string
	Name      i18n.Text
	DistanceM int32
	Capacity  int32
	StartAt   *time.Time
	CutoffAt  *time.Time
}

// Event 是赛事及其组别。
type Event struct {
	ID            int64
	Slug          string
	EventType     string
	OrganizerType string
	Name          i18n.Text
	City          string
	RaceDate      time.Time // 日期，UTC 零点
	Status        string    // StatusDraft | StatusPublished
	PublicVisible bool
	PublishedAt   *time.Time
	Categories    []Category
}

// CategoryInput 是新建赛事时提交的组别。
type CategoryInput struct {
	Code      string
	Name      i18n.Text
	DistanceM int32
	Capacity  int32
	StartAt   *time.Time
	CutoffAt  *time.Time
}

// CreateInput 是新建赛事（草稿）的输入。
type CreateInput struct {
	Slug          string
	EventType     string
	OrganizerType string
	Name          i18n.Text
	City          string
	RaceDate      time.Time
	Categories    []CategoryInput
}
```

创建 `api/internal/event/validate.go`：

```go
package event

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

const slugMaxLen = 60

var (
	slugPattern         = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	categoryCodePattern = regexp.MustCompile(`^[0-9A-Z]{1,10}$`)
	requiredLangs       = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}
)

// ValidateCreate 校验新建赛事的输入，一次返回全部字段错误。
func ValidateCreate(in CreateInput) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}

	switch {
	case in.Slug == "":
		add("slug", "field.required", nil)
	case len(in.Slug) > slugMaxLen:
		add("slug", "field.too_long", map[string]any{"max": slugMaxLen})
	case !slugPattern.MatchString(in.Slug):
		add("slug", "field.slug_format", nil)
	}
	if in.EventType != TypeRace && in.EventType != TypeFreeActivity {
		add("eventType", "field.invalid", nil)
	}
	if in.OrganizerType != OrganizerOfficial && in.OrganizerType != OrganizerPartner {
		add("organizerType", "field.invalid", nil)
	}
	for _, l := range requiredLangs {
		if strings.TrimSpace(in.Name[l]) == "" {
			add("name."+string(l), "field.required", nil)
		}
	}
	if strings.TrimSpace(in.City) == "" {
		add("city", "field.required", nil)
	}
	if in.RaceDate.IsZero() {
		add("raceDate", "field.required", nil)
	}

	seenCodes := make(map[string]bool, len(in.Categories))
	for i, c := range in.Categories {
		prefix := fmt.Sprintf("categories[%d].", i)
		switch {
		case !categoryCodePattern.MatchString(c.Code):
			add(prefix+"code", "field.category_code_format", nil)
		case seenCodes[c.Code]:
			add(prefix+"code", apperr.CodeEventCategoryCodeTaken, nil)
		}
		seenCodes[c.Code] = true
		for _, l := range requiredLangs {
			if strings.TrimSpace(c.Name[l]) == "" {
				add(prefix+"name."+string(l), "field.required", nil)
			}
		}
		if c.DistanceM <= 0 {
			add(prefix+"distanceM", "field.must_be_positive", nil)
		}
		if c.Capacity < 1 {
			add(prefix+"capacity", "field.must_be_positive", nil)
		}
		if c.StartAt != nil && c.CutoffAt != nil && !c.CutoffAt.After(*c.StartAt) {
			add(prefix+"cutoffAt", "field.cutoff_before_start", nil)
		}
	}

	if failed {
		return verr
	}
	return nil
}

// ValidateForPublish 是发布前校验（样例版，spec §7.2）。
// 完整规则里的"每个组别必须配置价格档"在报名迭代中加入。
func ValidateForPublish(e Event) error {
	if e.Status == StatusPublished {
		return apperr.New(http.StatusConflict, apperr.CodeEventAlreadyPublished)
	}
	if len(e.Categories) == 0 {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeEventNoCategory).
			WithField("categories", apperr.CodeEventNoCategory, nil)
	}

	var problems []string
	for _, c := range e.Categories {
		var missing []string
		if c.Capacity <= 0 {
			missing = append(missing, "capacity")
		}
		if c.StartAt == nil {
			missing = append(missing, "start_at")
		}
		if c.CutoffAt == nil {
			missing = append(missing, "cutoff_at")
		}
		if c.StartAt != nil && c.CutoffAt != nil && !c.CutoffAt.After(*c.StartAt) {
			missing = append(missing, "cutoff_before_start")
		}
		if len(missing) > 0 {
			problems = append(problems, c.Code+": "+strings.Join(missing, ", "))
		}
	}
	if len(problems) > 0 {
		params := map[string]any{"missing": strings.Join(problems, "; ")}
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeEventCategoryIncomplete).
			WithParams(params).
			WithField("categories", "field.category_incomplete", params)
	}
	return nil
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd api && go test ./internal/event/ -run 'TestValidate' -v`
Expected: `TestValidateCreateAcceptsValidInput`、`TestValidateCreateAllowsCategoryWithoutTimes`、`TestValidateCreateRejectsInvalidInput`（16 个子测试）、`TestValidateForPublish`（7 个子测试）全部 PASS。

- [ ] **Step 5: 提交校验**

```bash
git add api/internal/event/model.go api/internal/event/validate.go api/internal/event/validate_test.go
git commit -m "$(cat <<'EOF'
feat(api): add event model with create and publish validation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

- [ ] **Step 6: 写 sqlc 查询并加 event 块**

创建 `api/db/queries/event.sql`：

```sql
-- name: InsertEvent :one
INSERT INTO events (slug, event_type, organizer_type, name, city, race_date, created_by)
VALUES (@slug, @event_type, @organizer_type, @name, @city, @race_date, @created_by)
RETURNING *;

-- name: InsertCategory :one
INSERT INTO event_categories (event_id, code, name, distance_m, capacity, start_at, cutoff_at, sort_order)
VALUES (@event_id, @code, @name, @distance_m, @capacity, @start_at, @cutoff_at, @sort_order)
RETURNING *;

-- name: ListEvents :many
SELECT * FROM events
ORDER BY race_date DESC, id DESC;

-- name: ListPublicEvents :many
SELECT * FROM events
WHERE status = 'PUBLISHED' AND public_visible
ORDER BY race_date, id;

-- name: GetPublicEventBySlug :one
SELECT * FROM events
WHERE slug = @slug AND status = 'PUBLISHED' AND public_visible;

-- name: GetEventForUpdate :one
SELECT * FROM events
WHERE id = @id
FOR UPDATE;

-- name: ListCategoriesByEventIDs :many
SELECT * FROM event_categories
WHERE event_id = ANY(@event_ids::bigint[])
ORDER BY event_id, sort_order, id;

-- name: PublishEvent :one
UPDATE events
SET status = 'PUBLISHED',
    public_visible = true,
    published_at = @published_at,
    published_by = @published_by,
    version = version + 1
WHERE id = @id
RETURNING *;
```

把 `api/sqlc.yaml` 整文件替换为下面内容：iam 块保持 Task 7 的写法，按 C13b 追加 event 块。

```yaml
version: "2"
sql:
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/iam.sql
    gen:
      go:
        package: store
        out: internal/iam/store
        sql_package: pgx/v5
        emit_pointers_for_null_types: true
        overrides:
          - db_type: timestamptz
            go_type: time.Time
          - db_type: timestamptz
            nullable: true
            go_type:
              type: time.Time
              pointer: true
          - db_type: date
            go_type: time.Time
          - db_type: inet
            nullable: true
            go_type:
              import: net/netip
              type: Addr
              pointer: true
  - engine: postgresql
    schema: db/migrations
    queries: db/queries/event.sql
    gen:
      go:
        package: store
        out: internal/event/store
        sql_package: pgx/v5
        emit_pointers_for_null_types: true
        overrides:
          - db_type: timestamptz
            go_type: time.Time
          - db_type: timestamptz
            nullable: true
            go_type:
              type: time.Time
              pointer: true
          - db_type: date
            go_type: time.Time
          - db_type: inet
            nullable: true
            go_type:
              import: net/netip
              type: Addr
              pointer: true
```

- [ ] **Step 7: 生成 store 代码并确认结构**

Run: `make gen-api && cd api && go build ./... && grep -n "func (q \*Queries)" internal/event/store/event.sql.go`

Expected：
- 编译通过。
- grep 列出 8 个方法：`GetEventForUpdate`、`GetPublicEventBySlug`、`InsertCategory`、`InsertEvent`、`ListCategoriesByEventIDs`、`ListEvents`、`ListPublicEvents`、`PublishEvent`。
- `internal/event/store/models.go` 里 `type Event struct` 含 `Name []byte`、`RaceDate time.Time`、`PublishedAt *time.Time`、`CreatedBy *int64`；`type EventCategory struct` 含 `StartAt *time.Time`、`SortOrder int16`。

如果字段类型和上面不一致，按实际生成结果调整 Step 10 里 `eventFromRow` / `categoryFromRow` 的赋值。

- [ ] **Step 8: 写服务层的失败测试**

创建 `api/internal/event/service_test.go`：

```go
package event_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
)

func newActor(t *testing.T, pool *pgxpool.Pool, role iam.Role, username string) iam.Staff {
	t.Helper()
	svc := iam.NewService(pool, []byte(strings.Repeat("s", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	staff, err := svc.CreateStaff(context.Background(), username, "Test "+string(role), role, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	return staff
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func TestServiceCreateWritesEventCategoriesAndAudit(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.create")

	created, err := svc.Create(context.Background(), actor, validInput())

	require.NoError(t, err)
	require.NotZero(t, created.ID)
	require.Equal(t, event.StatusDraft, created.Status)
	require.False(t, created.PublicVisible)
	require.Nil(t, created.PublishedAt)
	require.Equal(t, "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦", created.Name[i18n.KM])
	require.True(t, created.RaceDate.Equal(time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)))
	require.Len(t, created.Categories, 1)
	require.Equal(t, "21K", created.Categories[0].Code)
	require.NotNil(t, created.Categories[0].StartAt)
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'event.create' AND entity_type = 'event' AND entity_id = $1 AND actor_id = $2`,
		created.ID, actor.ID))
}

func TestServiceCreateRejectsDuplicateSlug(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.dup")
	ctx := context.Background()

	_, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)
	_, err = svc.Create(ctx, actor, validInput())

	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeEventSlugTaken, ae.Code)
	require.Equal(t, http.StatusConflict, ae.Status)
	require.Equal(t, apperr.CodeEventSlugTaken, fieldKeys(t, err)["slug"])
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM events WHERE slug = 'pphm-2026'`))
}

func TestServiceCreateValidationFailureWritesNothing(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.invalid")
	in := validInput()
	in.Slug = ""

	_, err := svc.Create(context.Background(), actor, in)

	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM events`))
}

func TestServicePublishRejectsIncompleteCategory(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.incomplete")
	ctx := context.Background()
	in := validInput()
	in.Categories[0].StartAt = nil
	in.Categories[0].CutoffAt = nil
	created, err := svc.Create(ctx, actor, in)
	require.NoError(t, err)

	_, err = svc.Publish(ctx, actor, created.ID)

	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeEventCategoryIncomplete, ae.Code)
	require.Equal(t, "21K: start_at, cutoff_at", ae.Fields["categories"].Params["missing"])
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM events WHERE id = $1 AND status = 'DRAFT'`, created.ID))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'event.publish'`))
}

func TestServicePublishSucceedsOnceAndIsAudited(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.publish")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)

	published, err := svc.Publish(ctx, actor, created.ID)

	require.NoError(t, err)
	require.Equal(t, event.StatusPublished, published.Status)
	require.True(t, published.PublicVisible)
	require.NotNil(t, published.PublishedAt)
	require.Len(t, published.Categories, 1)
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'event.publish' AND entity_id = $1`, created.ID))

	_, err = svc.Publish(ctx, actor, created.ID)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventAlreadyPublished, ae.Code)
	require.Equal(t, http.StatusConflict, ae.Status)
}

func TestServicePublishUnknownEvent(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.unknown")

	_, err := svc.Publish(context.Background(), actor, 999999)

	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)
	require.Equal(t, http.StatusNotFound, ae.Status)
}

func TestServicePublicQueriesExcludeDrafts(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.list")
	ctx := context.Background()

	draft := validInput()
	draft.Slug = "draft-run"
	_, err := svc.Create(ctx, actor, draft)
	require.NoError(t, err)

	live := validInput()
	live.Slug = "published-run"
	liveEvent, err := svc.Create(ctx, actor, live)
	require.NoError(t, err)
	_, err = svc.Publish(ctx, actor, liveEvent.ID)
	require.NoError(t, err)

	public, err := svc.ListPublic(ctx)
	require.NoError(t, err)
	require.Len(t, public, 1)
	require.Equal(t, "published-run", public[0].Slug)
	require.Len(t, public[0].Categories, 1)

	got, err := svc.GetPublic(ctx, "published-run")
	require.NoError(t, err)
	require.Equal(t, liveEvent.ID, got.ID)

	_, err = svc.GetPublic(ctx, "draft-run")
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)

	all, err := svc.ListAll(ctx)
	require.NoError(t, err)
	require.Len(t, all, 2)
}
```

- [ ] **Step 9: 运行测试，确认失败**

Run: `cd api && go test ./internal/event/ -run 'TestService' -v`
Expected: 编译失败，报 `undefined: event.NewService`。

- [ ] **Step 10: 实现服务层**

创建 `api/internal/event/service.go`：

```go
package event

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/event/store"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func init() {
	apperr.RegisterConstraint("events_slug_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken).
			WithField("slug", apperr.CodeEventSlugTaken, nil)
	})
	apperr.RegisterConstraint("event_categories_event_id_code_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeEventCategoryCodeTaken)
	})
}

// Service 是赛事模块的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建赛事服务。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: time.Now}
}

// Create 新建草稿赛事及其组别，并写审计 event.create。
func (s *Service) Create(ctx context.Context, actor iam.Staff, in CreateInput) (Event, error) {
	if err := ValidateCreate(in); err != nil {
		return Event{}, err
	}
	name, err := json.Marshal(in.Name)
	if err != nil {
		return Event{}, fmt.Errorf("encode event name: %w", err)
	}

	var out Event
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		actorID := actor.ID
		row, err := q.InsertEvent(ctx, store.InsertEventParams{
			Slug:          in.Slug,
			EventType:     in.EventType,
			OrganizerType: in.OrganizerType,
			Name:          name,
			City:          in.City,
			RaceDate:      in.RaceDate,
			CreatedBy:     &actorID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		ev, err := eventFromRow(row)
		if err != nil {
			return err
		}

		for i, c := range in.Categories {
			catName, err := json.Marshal(c.Name)
			if err != nil {
				return fmt.Errorf("encode category name: %w", err)
			}
			crow, err := q.InsertCategory(ctx, store.InsertCategoryParams{
				EventID:   ev.ID,
				Code:      c.Code,
				Name:      catName,
				DistanceM: c.DistanceM,
				Capacity:  c.Capacity,
				StartAt:   c.StartAt,
				CutoffAt:  c.CutoffAt,
				SortOrder: int16(i),
			})
			if err != nil {
				return apperr.FromPG(err)
			}
			cat, err := categoryFromRow(crow)
			if err != nil {
				return err
			}
			ev.Categories = append(ev.Categories, cat)
		}

		out = ev
		return audit.Record(ctx, tx, staffAudit(ctx, actor, "event.create", ev,
			fmt.Sprintf("新建赛事 %s（%d 个组别）", ev.Slug, len(ev.Categories))))
	})
	if err != nil {
		return Event{}, err
	}
	return out, nil
}

// Publish 锁定赛事行，做发布前校验，置为已发布并公开展示，写审计 event.publish。
func (s *Service) Publish(ctx context.Context, actor iam.Staff, id int64) (Event, error) {
	var out Event
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetEventForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %d: %w", id, err)
		}
		ev, err := eventFromRow(row)
		if err != nil {
			return err
		}
		cats, err := loadCategories(ctx, q, []int64{ev.ID})
		if err != nil {
			return err
		}
		ev.Categories = cats[ev.ID]

		if err := ValidateForPublish(ev); err != nil {
			return err
		}

		now := s.now().UTC()
		actorID := actor.ID
		updated, err := q.PublishEvent(ctx, store.PublishEventParams{
			PublishedAt: &now,
			PublishedBy: &actorID,
			ID:          ev.ID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		published, err := eventFromRow(updated)
		if err != nil {
			return err
		}
		published.Categories = ev.Categories

		out = published
		return audit.Record(ctx, tx, staffAudit(ctx, actor, "event.publish", published,
			fmt.Sprintf("发布赛事 %s", published.Slug)))
	})
	if err != nil {
		return Event{}, err
	}
	return out, nil
}

// ListAll 返回全部赛事（后台用），按比赛日期倒序。
func (s *Service) ListAll(ctx context.Context) ([]Event, error) {
	q := store.New(s.pool)
	rows, err := q.ListEvents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	return withCategories(ctx, q, rows)
}

// ListPublic 返回已发布且公开展示的赛事，按比赛日期升序。
func (s *Service) ListPublic(ctx context.Context) ([]Event, error) {
	q := store.New(s.pool)
	rows, err := q.ListPublicEvents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list public events: %w", err)
	}
	return withCategories(ctx, q, rows)
}

// GetPublic 按 slug 取已发布且公开展示的赛事；不存在或未公开返回 EVENT_NOT_FOUND。
func (s *Service) GetPublic(ctx context.Context, slug string) (Event, error) {
	q := store.New(s.pool)
	row, err := q.GetPublicEventBySlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return Event{}, fmt.Errorf("get public event %q: %w", slug, err)
	}
	events, err := withCategories(ctx, q, []store.Event{row})
	if err != nil {
		return Event{}, err
	}
	return events[0], nil
}

func withCategories(ctx context.Context, q *store.Queries, rows []store.Event) ([]Event, error) {
	events := make([]Event, 0, len(rows))
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ev, err := eventFromRow(r)
		if err != nil {
			return nil, err
		}
		events = append(events, ev)
		ids = append(ids, ev.ID)
	}
	cats, err := loadCategories(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range events {
		events[i].Categories = cats[events[i].ID]
	}
	return events, nil
}

func loadCategories(ctx context.Context, q *store.Queries, eventIDs []int64) (map[int64][]Category, error) {
	out := make(map[int64][]Category, len(eventIDs))
	if len(eventIDs) == 0 {
		return out, nil
	}
	rows, err := q.ListCategoriesByEventIDs(ctx, eventIDs)
	if err != nil {
		return nil, fmt.Errorf("list categories: %w", err)
	}
	for _, r := range rows {
		c, err := categoryFromRow(r)
		if err != nil {
			return nil, err
		}
		out[r.EventID] = append(out[r.EventID], c)
	}
	return out, nil
}

func eventFromRow(r store.Event) (Event, error) {
	var name i18n.Text
	if err := json.Unmarshal(r.Name, &name); err != nil {
		return Event{}, fmt.Errorf("decode name of event %d: %w", r.ID, err)
	}
	return Event{
		ID:            r.ID,
		Slug:          r.Slug,
		EventType:     r.EventType,
		OrganizerType: r.OrganizerType,
		Name:          name,
		City:          r.City,
		RaceDate:      r.RaceDate,
		Status:        r.Status,
		PublicVisible: r.PublicVisible,
		PublishedAt:   r.PublishedAt,
	}, nil
}

func categoryFromRow(r store.EventCategory) (Category, error) {
	var name i18n.Text
	if err := json.Unmarshal(r.Name, &name); err != nil {
		return Category{}, fmt.Errorf("decode name of category %d: %w", r.ID, err)
	}
	return Category{
		ID:        r.ID,
		Code:      r.Code,
		Name:      name,
		DistanceM: r.DistanceM,
		Capacity:  r.Capacity,
		StartAt:   r.StartAt,
		CutoffAt:  r.CutoffAt,
	}, nil
}

func staffAudit(ctx context.Context, actor iam.Staff, action string, ev Event, summary string) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	eventID := ev.ID
	codes := make([]string, 0, len(ev.Categories))
	for _, c := range ev.Categories {
		codes = append(codes, c.Code)
	}
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: "event",
		EntityID:   ev.ID,
		EventID:    &eventID,
		Summary:    summary,
		After: map[string]any{
			"slug":          ev.Slug,
			"status":        ev.Status,
			"publicVisible": ev.PublicVisible,
			"categories":    codes,
		},
		Meta: httpx.MetaOf(ctx),
	}
}
```

- [ ] **Step 11: 运行测试，确认通过**

Run: `cd api && go test ./internal/event/ -v`（需要 Docker）
Expected：
- 7 个 `TestService*` 与前面的 `TestValidate*` 全部 PASS，输出 `ok  werun/api/internal/event`。
- 如果 Step 7 核对时 store 字段类型不同，编译错误会指向 `eventFromRow` / `categoryFromRow` 的对应行，按生成类型调整后再运行。

- [ ] **Step 12: 提交存储与服务层**

```bash
git add api/db/queries/event.sql api/sqlc.yaml api/internal/event/store api/internal/event/service.go api/internal/event/service_test.go
git commit -m "$(cat <<'EOF'
feat(api): add event store and service with audited create and publish

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```

- [ ] **Step 13: 在 openapi.yaml 中新增赛事接口**

编辑 `api/openapi/openapi.yaml`。

在 `paths:` 下（已有 `/healthz`、`/readyz`、`/admin/...` 的同一层级）追加：

```yaml
  /events:
    get:
      operationId: listPublicEvents
      summary: 已发布且公开展示的赛事列表，文案按请求语言返回
      responses:
        '200':
          description: 赛事列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PublicEventList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /events/{slug}:
    get:
      operationId: getPublicEvent
      summary: 赛事详情（含组别）
      parameters:
        - name: slug
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: 赛事详情
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PublicEvent'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/events:
    get:
      operationId: adminListEvents
      summary: 后台赛事列表（名称返回三语）
      x-permission: event_config
      x-access: read
      responses:
        '200':
          description: 赛事列表
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminEventList'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
    post:
      operationId: adminCreateEvent
      summary: 新建草稿赛事及组别
      x-permission: event_config
      x-access: write
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateEventRequest'
      responses:
        '201':
          description: 已创建
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminEvent'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
  /admin/events/{id}/publish:
    post:
      operationId: adminPublishEvent
      summary: 发布赛事（发布前校验）
      x-permission: event_publish
      x-access: write
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: 已发布
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AdminEvent'
        default:
          description: 错误
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

在 `components:` → `schemas:` 下追加：

```yaml
    LocalizedText:
      type: object
      additionalProperties: false
      properties:
        zh:
          type: string
        en:
          type: string
        km:
          type: string
    PublicCategory:
      type: object
      required: [code, name, distanceM, capacity, startAt, cutoffAt]
      properties:
        code:
          type: string
        name:
          type: string
        distanceM:
          type: integer
          format: int32
        capacity:
          type: integer
          format: int32
        startAt:
          type: string
          format: date-time
        cutoffAt:
          type: string
          format: date-time
    PublicEvent:
      type: object
      required: [slug, name, city, raceDate, categories]
      properties:
        slug:
          type: string
        name:
          type: string
        city:
          type: string
        raceDate:
          type: string
          format: date
        categories:
          type: array
          items:
            $ref: '#/components/schemas/PublicCategory'
    PublicEventList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/PublicEvent'
    AdminCategory:
      type: object
      required: [id, code, name, distanceM, capacity, startAt, cutoffAt]
      properties:
        id:
          type: integer
          format: int64
        code:
          type: string
        name:
          $ref: '#/components/schemas/LocalizedText'
        distanceM:
          type: integer
          format: int32
        capacity:
          type: integer
          format: int32
        startAt:
          type: string
          format: date-time
          nullable: true
        cutoffAt:
          type: string
          format: date-time
          nullable: true
    AdminEvent:
      type: object
      required: [id, slug, eventType, organizerType, name, city, raceDate, status, publicVisible, publishedAt, categories]
      properties:
        id:
          type: integer
          format: int64
        slug:
          type: string
        eventType:
          type: string
          enum: [RACE, FREE_ACTIVITY]
        organizerType:
          type: string
          enum: [OFFICIAL, PARTNER]
        name:
          $ref: '#/components/schemas/LocalizedText'
        city:
          type: string
        raceDate:
          type: string
          format: date
        status:
          type: string
          enum: [DRAFT, PUBLISHED]
        publicVisible:
          type: boolean
        publishedAt:
          type: string
          format: date-time
          nullable: true
        categories:
          type: array
          items:
            $ref: '#/components/schemas/AdminCategory'
    AdminEventList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/AdminEvent'
    CreateCategoryRequest:
      type: object
      required: [code, name, distanceM, capacity]
      properties:
        code:
          type: string
        name:
          $ref: '#/components/schemas/LocalizedText'
        distanceM:
          type: integer
          format: int32
        capacity:
          type: integer
          format: int32
        startAt:
          type: string
          format: date-time
          nullable: true
        cutoffAt:
          type: string
          format: date-time
          nullable: true
    CreateEventRequest:
      type: object
      required: [slug, eventType, organizerType, name, city, raceDate, categories]
      properties:
        slug:
          type: string
        eventType:
          type: string
          enum: [RACE, FREE_ACTIVITY]
        organizerType:
          type: string
          enum: [OFFICIAL, PARTNER]
        name:
          $ref: '#/components/schemas/LocalizedText'
        city:
          type: string
        raceDate:
          type: string
          format: date
        categories:
          type: array
          items:
            $ref: '#/components/schemas/CreateCategoryRequest'
```

- [ ] **Step 14: 重新生成，确认 Server 缺少新方法**

Run: `make gen-api && cd api && grep -n '"adminCreateEvent"\|"adminPublishEvent"\|"adminListEvents"\|"listPublicEvents"\|"getPublicEvent"' internal/httpapi/apigen/permissions.gen.go && go build ./...`

Expected：
- grep 输出 5 行：`adminListEvents` 为 `AuthPermission` + `event_config` + `read`；`adminCreateEvent` 为 `event_config` + `write`；`adminPublishEvent` 为 `event_publish` + `write`；两个公开操作为 `AuthNone`。
- `go build` 失败，报 `*Server` 没有实现 `apigen.StrictServerInterface`，缺少 `AdminCreateEvent`（或其他新方法）。这是预期结果，下面实现。

生成代码里本任务要用到的名字（oapi-codegen v2.8.0 默认命名）：
- `apigen.ListPublicEventsRequestObject`、`apigen.ListPublicEventsResponseObject`、`apigen.ListPublicEvents200JSONResponse`，其余操作同理。
- `apigen.GetPublicEventRequestObject{Slug string}`、`apigen.AdminPublishEventRequestObject{Id int64}`、`apigen.AdminCreateEventRequestObject{Body *apigen.AdminCreateEventJSONRequestBody}`。
- 枚举类型 `apigen.AdminEventEventType`、`apigen.AdminEventOrganizerType`、`apigen.AdminEventStatus`、`apigen.CreateEventRequestEventType`、`apigen.CreateEventRequestOrganizerType`。
- 日期字段是 `openapi_types.Date`（`github.com/oapi-codegen/runtime/types`，字段 `Time time.Time`）。
- 可空的 date-time 是 `*time.Time`；`LocalizedText` 的三个字段是 `*string`。

下面代码只对枚举类型做 `string` 与类型之间的转换，不引用枚举常量名，所以不受常量命名方式影响。

- [ ] **Step 15: 写 HTTP 集成测试（失败）**

创建 `api/internal/httpapi/events_http_test.go`（辅助函数统一以 `events` 为前缀，避免和 Task 5/8 的测试辅助函数重名）：

```go
package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/httpapi"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
)

type eventsEnv struct {
	router  http.Handler
	iam     *iam.Service
	catalog *i18n.Catalog
}

func newEventsEnv(t *testing.T) eventsEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	pool := dbtest.NewPool(t)
	catalog, err := i18n.LoadCatalog()
	require.NoError(t, err)

	iamSvc := iam.NewService(pool, []byte(strings.Repeat("k", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Log:     logx.New("error", io.Discard),
		Catalog: catalog,
		Pool:    pool,
		IAM:     iamSvc,
		Events:  event.NewService(pool),
		Env:     "dev",
	})
	return eventsEnv{router: router, iam: iamSvc, catalog: catalog}
}

func (e eventsEnv) sessionCookie(t *testing.T, role iam.Role, username string) *http.Cookie {
	t.Helper()
	const password = "Correct-Horse-Battery-9"
	ctx := context.Background()
	_, err := e.iam.CreateStaff(ctx, username, "HTTP "+string(role), role, password)
	require.NoError(t, err)
	token, _, err := e.iam.Login(ctx, username, password, httpx.Meta{IP: "127.0.0.1", UserAgent: "events-http-test"})
	require.NoError(t, err)
	return &http.Cookie{Name: iam.CookieName, Value: token}
}

func (e eventsEnv) do(t *testing.T, method, path string, body any, cookie *http.Cookie, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, values := range header {
		for _, v := range values {
			req.Header.Add(k, v)
		}
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func eventsCreateBody() map[string]any {
	return map[string]any{
		"slug":          "pphm-2026",
		"eventType":     "RACE",
		"organizerType": "OFFICIAL",
		"name": map[string]string{
			"zh": "金边半程马拉松 2026",
			"en": "Phnom Penh Half Marathon 2026",
			"km": "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
		},
		"city":     "Phnom Penh",
		"raceDate": "2026-11-15",
		"categories": []map[string]any{{
			"code": "21K",
			"name": map[string]string{
				"zh": "半程 21K",
				"en": "Half Marathon 21K",
				"km": "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K",
			},
			"distanceM": 21097,
			"capacity":  800,
			"startAt":   "2026-11-15T06:00:00+07:00",
			"cutoffAt":  "2026-11-15T09:30:00+07:00",
		}},
	}
}

func eventsDecode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &v), rec.Body.String())
	return v
}

func TestOpsCreatesAndPublishesEventThenPublicSeesIt(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.http")
	adminClient := http.Header{httpx.HeaderClient: []string{"admin"}}

	rec := env.do(t, http.MethodPost, "/api/admin/events", eventsCreateBody(), ops, adminClient)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.AdminEvent](t, rec)
	require.Equal(t, "DRAFT", string(created.Status))
	require.False(t, created.PublicVisible)
	require.Len(t, created.Categories, 1)

	rec = env.do(t, http.MethodGet, "/api/events", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Empty(t, eventsDecode[apigen.PublicEventList](t, rec).Items, "草稿不应出现在公开列表")

	rec = env.do(t, http.MethodPost, fmt.Sprintf("/api/admin/events/%d/publish", created.Id), nil, ops, adminClient)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	published := eventsDecode[apigen.AdminEvent](t, rec)
	require.Equal(t, "PUBLISHED", string(published.Status))
	require.True(t, published.PublicVisible)
	require.NotNil(t, published.PublishedAt)

	rec = env.do(t, http.MethodGet, "/api/events?lang=km", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	list := eventsDecode[apigen.PublicEventList](t, rec)
	require.Len(t, list.Items, 1)
	require.Equal(t, "pphm-2026", list.Items[0].Slug)
	require.Equal(t, "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦", list.Items[0].Name)
	require.Equal(t, "2026-11-15", list.Items[0].RaceDate.Time.Format("2006-01-02"))
	require.Equal(t, "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K", list.Items[0].Categories[0].Name)

	rec = env.do(t, http.MethodGet, "/api/events/pphm-2026?lang=en", nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "Phnom Penh Half Marathon 2026", eventsDecode[apigen.PublicEvent](t, rec).Name)

	rec = env.do(t, http.MethodGet, "/api/events/does-not-exist", nil, nil, nil)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeEventNotFound, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}

func TestAdminRoleCanReadButCannotCreateEvents(t *testing.T) {
	env := newEventsEnv(t)
	admin := env.sessionCookie(t, iam.RoleAdmin, "admin.http")

	rec := env.do(t, http.MethodPost, "/api/admin/events", eventsCreateBody(), admin, http.Header{
		httpx.HeaderClient: []string{"admin"},
		"Accept-Language":  []string{"zh-CN,zh;q=0.9"},
	})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	body := eventsDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeForbidden, body.Error.Code)
	require.Equal(t, env.catalog.T(i18n.ZH, apperr.CodeForbidden, nil), body.Error.Message)

	rec = env.do(t, http.MethodGet, "/api/admin/events", nil, admin, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestAdminEventsRequireSession(t *testing.T) {
	env := newEventsEnv(t)

	rec := env.do(t, http.MethodGet, "/api/admin/events", nil, nil, nil)

	require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeUnauthenticated, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)
}
```

- [ ] **Step 16: 运行测试，确认失败**

Run: `cd api && go test ./internal/httpapi/ -run 'TestOpsCreates|TestAdminRole|TestAdminEventsRequire' -v`
Expected: 编译失败，报 `undefined: httpapi.NewServer` 和 `undefined: event.NewHandlers`。

- [ ] **Step 17: 实现 handler，重写 Server，接入命令行**

创建 `api/internal/event/handlers.go`：

```go
package event

import (
	"context"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// Handlers 实现 apigen.StrictServerInterface 中的赛事相关操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建赛事 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) ListPublicEvents(ctx context.Context, _ apigen.ListPublicEventsRequestObject) (apigen.ListPublicEventsResponseObject, error) {
	events, err := h.svc.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	lang := httpx.LangOf(ctx)
	items := make([]apigen.PublicEvent, 0, len(events))
	for _, e := range events {
		items = append(items, toPublicEvent(e, lang))
	}
	return apigen.ListPublicEvents200JSONResponse{Items: items}, nil
}

func (h *Handlers) GetPublicEvent(ctx context.Context, req apigen.GetPublicEventRequestObject) (apigen.GetPublicEventResponseObject, error) {
	ev, err := h.svc.GetPublic(ctx, req.Slug)
	if err != nil {
		return nil, err
	}
	return apigen.GetPublicEvent200JSONResponse(toPublicEvent(ev, httpx.LangOf(ctx))), nil
}

func (h *Handlers) AdminListEvents(ctx context.Context, _ apigen.AdminListEventsRequestObject) (apigen.AdminListEventsResponseObject, error) {
	events, err := h.svc.ListAll(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.AdminEvent, 0, len(events))
	for _, e := range events {
		items = append(items, toAdminEvent(e))
	}
	return apigen.AdminListEvents200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreateEvent(ctx context.Context, req apigen.AdminCreateEventRequestObject) (apigen.AdminCreateEventResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	ev, err := h.svc.Create(ctx, actor, createInputFromAPI(*req.Body))
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreateEvent201JSONResponse(toAdminEvent(ev)), nil
}

func (h *Handlers) AdminPublishEvent(ctx context.Context, req apigen.AdminPublishEventRequestObject) (apigen.AdminPublishEventResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	ev, err := h.svc.Publish(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminPublishEvent200JSONResponse(toAdminEvent(ev)), nil
}

func toPublicEvent(e Event, lang i18n.Lang) apigen.PublicEvent {
	cats := make([]apigen.PublicCategory, 0, len(e.Categories))
	for _, c := range e.Categories {
		cats = append(cats, apigen.PublicCategory{
			Code:      c.Code,
			Name:      c.Name.In(lang),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   derefTime(c.StartAt),
			CutoffAt:  derefTime(c.CutoffAt),
		})
	}
	return apigen.PublicEvent{
		Slug:       e.Slug,
		Name:       e.Name.In(lang),
		City:       e.City,
		RaceDate:   openapi_types.Date{Time: e.RaceDate},
		Categories: cats,
	}
}

func toAdminEvent(e Event) apigen.AdminEvent {
	cats := make([]apigen.AdminCategory, 0, len(e.Categories))
	for _, c := range e.Categories {
		cats = append(cats, apigen.AdminCategory{
			Id:        c.ID,
			Code:      c.Code,
			Name:      textToAPI(c.Name),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   c.StartAt,
			CutoffAt:  c.CutoffAt,
		})
	}
	return apigen.AdminEvent{
		Id:            e.ID,
		Slug:          e.Slug,
		EventType:     apigen.AdminEventEventType(e.EventType),
		OrganizerType: apigen.AdminEventOrganizerType(e.OrganizerType),
		Name:          textToAPI(e.Name),
		City:          e.City,
		RaceDate:      openapi_types.Date{Time: e.RaceDate},
		Status:        apigen.AdminEventStatus(e.Status),
		PublicVisible: e.PublicVisible,
		PublishedAt:   e.PublishedAt,
		Categories:    cats,
	}
}

func createInputFromAPI(b apigen.CreateEventRequest) CreateInput {
	cats := make([]CategoryInput, 0, len(b.Categories))
	for _, c := range b.Categories {
		cats = append(cats, CategoryInput{
			Code:      c.Code,
			Name:      textFromAPI(c.Name),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   c.StartAt,
			CutoffAt:  c.CutoffAt,
		})
	}
	return CreateInput{
		Slug:          b.Slug,
		EventType:     string(b.EventType),
		OrganizerType: string(b.OrganizerType),
		Name:          textFromAPI(b.Name),
		City:          b.City,
		RaceDate:      b.RaceDate.Time,
		Categories:    cats,
	}
}

func textToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}

func textFromAPI(l apigen.LocalizedText) i18n.Text {
	t := i18n.Text{}
	if l.Zh != nil {
		t[i18n.ZH] = *l.Zh
	}
	if l.En != nil {
		t[i18n.EN] = *l.En
	}
	if l.Km != nil {
		t[i18n.KM] = *l.Km
	}
	return t
}

func derefTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}
```

把 `api/internal/httpapi/server.go` 整文件替换为：

```go
package httpapi

import (
	"werun/api/internal/event"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
)

// 各模块的 handler 类型都叫 Handlers，直接嵌入会出现同名字段；
// 用别名嵌入，字段名即别名（IAMHandlers、EventHandlers……）。
type (
	IAMHandlers   = iam.Handlers
	EventHandlers = event.Handlers
)

// Server 组合各模块的 handler，实现 apigen.StrictServerInterface。
// 新增模块时在这里嵌入该模块的 handler，并在 NewServer 中构造。
type Server struct {
	*HealthHandlers
	*IAMHandlers
	*EventHandlers
}

var _ apigen.StrictServerInterface = (*Server)(nil)

// NewServer 用路由依赖构造全部模块 handler。
func NewServer(d RouterDeps) *Server {
	return &Server{
		HealthHandlers: NewHealthHandlers(d.Pool),
		IAMHandlers:    iam.NewHandlers(d.IAM, d.Env == "prod"),
		EventHandlers:  event.NewHandlers(d.Events),
	}
}
```

修改 `api/internal/httpapi/router.go`：在 `RouterDeps` 的 `IAM     *iam.Service` 这一行下面加一行 `Events  *event.Service`，并在 import 中加入 `"werun/api/internal/event"`。

把 `api/cmd/werun/router.go` 整文件替换为：

```go
package main

import (
	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi"
)

// newRouter 装配 HTTP 路由。serve 命令与测试共用这一处装配逻辑。
func newRouter(app *App) *gin.Engine {
	return httpapi.NewRouter(httpapi.RouterDeps{
		Log:     app.Log,
		Catalog: app.Catalog,
		Pool:    app.Pool,
		IAM:     app.IAM,
		Events:  app.Events,
		Env:     app.Cfg.Env,
	})
}
```

修改 `api/cmd/werun/app.go`：
- 在 `App` 结构体的 `IAM *iam.Service` 这一行下面加一行：

```go
	Events  *event.Service
```

- 在 `Bootstrap` 中给 `IAM` 赋值的语句之后、`return` 之前加一行（`app` 换成 `Bootstrap` 里 `*App` 变量的实际名字）：

```go
	app.Events = event.NewService(app.Pool)
```

- 在 import 中加入 `"werun/api/internal/event"`。

- [ ] **Step 18: 运行 HTTP 测试，确认通过**

Run: `cd api && go test ./internal/httpapi/ -run 'TestOpsCreates|TestAdminRole|TestAdminEventsRequire' -v`
Expected: `TestOpsCreatesAndPublishesEventThenPublicSeesIt`、`TestAdminRoleCanReadButCannotCreateEvents`、`TestAdminEventsRequireSession` 全部 PASS。

- [ ] **Step 19: 全量测试、lint 与本地冒烟**

Run: `make gen-api && git diff --exit-code -- api/internal/httpapi/apigen api/internal/event/store && make lint-api && make test-api`
Expected: 生成代码没有差异（退出码 0）；golangci-lint 无问题；`go test ./...` 所有包 `ok`。

本地冒烟（临时 PostgreSQL，结束后删除）：

```bash
docker run -d --name werun-pg-task10 -e POSTGRES_USER=werun -e POSTGRES_PASSWORD=werun -e POSTGRES_DB=werun -p 55432:5432 postgres:16-alpine
cd api && set -a && . ../.env && set +a
go run ./cmd/werun migrate up
printf 'Correct-Horse-Battery-9\n' | go run ./cmd/werun create-staff --username ops.chan --full-name "Chanthou Ny" --role OPS --password-stdin
go run ./cmd/werun serve --with-worker &
JAR=$(mktemp)
curl -s -c "$JAR" -H 'Content-Type: application/json' -H 'X-WeRun-Client: admin' \
  -d '{"username":"ops.chan","password":"Correct-Horse-Battery-9"}' http://127.0.0.1:8080/api/admin/auth/login
curl -s -b "$JAR" -H 'Content-Type: application/json' -H 'X-WeRun-Client: admin' \
  -d '{"slug":"pphm-2026","eventType":"RACE","organizerType":"OFFICIAL","name":{"zh":"金边半程马拉松 2026","en":"Phnom Penh Half Marathon 2026","km":"ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦"},"city":"Phnom Penh","raceDate":"2026-11-15","categories":[{"code":"21K","name":{"zh":"半程 21K","en":"Half Marathon 21K","km":"ពាក់កណ្ដាលម៉ារ៉ាតុង 21K"},"distanceM":21097,"capacity":800,"startAt":"2026-11-15T06:00:00+07:00","cutoffAt":"2026-11-15T09:30:00+07:00"}]}' \
  http://127.0.0.1:8080/api/admin/events
curl -s -b "$JAR" -X POST -H 'X-WeRun-Client: admin' http://127.0.0.1:8080/api/admin/events/1/publish
curl -s 'http://127.0.0.1:8080/api/events?lang=km'
kill %1; rm -f "$JAR"; docker rm -f werun-pg-task10
```

Expected：
- 登录返回含 `"role":"OPS"` 的 JSON。
- 新建返回 `"status":"DRAFT"`。
- 发布返回 `"status":"PUBLISHED"`。
- 最后的 GET 返回 `{"items":[{"slug":"pphm-2026","name":"ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",...}]}`。

- [ ] **Step 20: 提交接口与装配**

```bash
git add api/openapi/openapi.yaml api/internal/httpapi api/internal/event/handlers.go api/cmd/werun
git commit -m "$(cat <<'EOF'
feat(api): expose public and admin event endpoints

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
)"
```
