package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/iam"
	"werun/api/internal/platform/config"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/logx"
)

// App 持有进程级依赖。后续任务会追加 Events 等字段。
type App struct {
	Cfg     config.Config
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
	IAM     *iam.Service
}

// Bootstrap 读取配置、创建日志器、加载文案并连接数据库。
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
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	app := &App{Cfg: cfg, Log: log, Catalog: cat, Pool: pool}
	app.IAM = iam.NewService(app.Pool, []byte(app.Cfg.SessionSecret), iam.NewLoginLimiter(time.Now), time.Now)
	return app, nil
}

// Close 释放进程级资源。
func (a *App) Close() {
	a.Pool.Close()
}
