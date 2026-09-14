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
