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

	"werun/api/internal/httpapi"
	"werun/api/internal/platform/migrate"
)

const shutdownTimeout = 30 * time.Second

func runServe(ctx context.Context, args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	autoMigrate := flags.Bool("auto-migrate", false, "启动前执行数据库迁移（只用于本地开发）")
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

	if app.Cfg.IsProd() {
		gin.SetMode(gin.ReleaseMode)
	}
	srv := &http.Server{
		Addr: app.Cfg.HTTPAddr,
		Handler: httpapi.NewRouter(httpapi.RouterDeps{
			Log:     app.Log,
			Catalog: app.Catalog,
			Pool:    app.Pool,
		}),
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

	select {
	case err := <-serveErr:
		if err != nil {
			app.Log.Error("http server failed", "error", err)
			return 1
		}
		return 0
	case <-ctx.Done():
	}

	app.Log.Info("shutting down", "timeout", shutdownTimeout.String())
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		app.Log.Error("graceful shutdown failed", "error", err)
		return 1
	}
	return 0
}
