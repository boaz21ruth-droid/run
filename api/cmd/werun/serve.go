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
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
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
