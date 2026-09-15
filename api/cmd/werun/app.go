package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/jobs"
	"werun/api/internal/payment"
	"werun/api/internal/platform/config"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/platform/storage"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

// App 持有进程级依赖。各业务服务在引入它的任务里追加字段。
type App struct {
	Cfg          config.Config
	Log          *slog.Logger
	Catalog      *i18n.Catalog
	Pool         *pgxpool.Pool
	Store        storage.Store
	PII          *piicrypt.Cipher
	Inserter     *river.Client[pgx.Tx] // 只入队，不执行任务
	IAM          *iam.Service
	Events       *event.Service
	Pricing      *pricing.Service
	Registration *registration.Service
	Payment      *payment.Service
	Runner       *runner.Service
}

// Bootstrap 读取配置、创建日志器、加载文案、连接数据库并构造各服务。
func Bootstrap(ctx context.Context) (*App, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	log := logx.New(cfg.LogLevel, os.Stdout)
	slog.SetDefault(log)
	cat, err := i18n.LoadCatalog()
	if err != nil {
		return nil, fmt.Errorf("load messages: %w", err)
	}
	files, err := storage.NewDisk(cfg.FilesDir)
	if err != nil {
		return nil, fmt.Errorf("open file storage: %w", err)
	}
	piiKey, err := cfg.PIIKeyBytes()
	if err != nil {
		return nil, fmt.Errorf("decode pii key: %w", err)
	}
	pii, err := piicrypt.New(piiKey)
	if err != nil {
		return nil, fmt.Errorf("create pii cipher: %w", err)
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	inserter, err := jobs.NewInserter(pool)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("create job inserter: %w", err)
	}
	app := &App{Cfg: cfg, Log: log, Catalog: cat, Pool: pool, Store: files, PII: pii, Inserter: inserter}
	app.Runner = runner.NewService(app.Pool, []byte(app.Cfg.SessionSecret), app.Cfg.TelegramBotToken, app.PII, time.Now)
	app.IAM = iam.NewService(app.Pool, []byte(app.Cfg.SessionSecret), iam.NewLoginLimiter(time.Now), time.Now)
	app.Events = event.NewService(app.Pool)
	app.Pricing = pricing.NewService(app.Pool, time.Now)
	app.Registration = registration.NewService(app.Pool, app.Runner, app.Pricing, time.Now)
	app.Payment = payment.NewService(app.Pool, app.Store, app.Registration, time.Now)
	return app, nil
}

// Close 释放进程级资源。
func (a *App) Close() {
	a.Pool.Close()
}
