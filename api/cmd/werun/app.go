package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/jobs"
	"werun/api/internal/notify"
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
	Notify       *notify.Service // Task 20
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
	app.Notify = notify.NewService(app.Inserter, app.Catalog, app.Cfg.AppBaseURL)
	app.Runner = runner.NewService(app.Pool, []byte(app.Cfg.SessionSecret), app.Cfg.TelegramBotToken, app.PII, time.Now,
		newOTPSender(app.Cfg, app.Log), runner.NewOTPLimiter(time.Now))
	app.IAM = iam.NewService(app.Pool, []byte(app.Cfg.SessionSecret), iam.NewLoginLimiter(time.Now), time.Now)
	app.Events = event.NewService(app.Pool)
	app.Pricing = pricing.NewService(app.Pool, time.Now)
	app.Registration = registration.NewService(app.Pool, app.Runner, app.Pricing, app.Notify, time.Now)
	app.Payment = payment.NewService(app.Pool, app.Store, app.Registration, app.Notify, time.Now)
	return app, nil
}

// Close 释放进程级资源。
func (a *App) Close() {
	a.Pool.Close()
}

// newNotifySender 按 WERUN_TELEGRAM_SEND 选择发送实现：开启时调用 Telegram Bot API，关闭时只写日志。
func newNotifySender(cfg config.Config, log *slog.Logger) notify.Sender {
	if cfg.TelegramSendEnabled() {
		return notify.NewTelegramSender(cfg.TelegramBotToken, notify.DefaultTelegramBaseURL, &http.Client{Timeout: 10 * time.Second})
	}
	return notify.LogSender{Log: log}
}

// newOTPSender 按 WERUN_OTP_SENDER 选择验证码发送器（config.Load 已保证 prod 只能是 telegram）。
func newOTPSender(cfg config.Config, log *slog.Logger) runner.OTPSender {
	switch cfg.OTPSenderKind() {
	case "telegram":
		return runner.NewGatewaySender(cfg.TelegramGatewayToken, runner.DefaultGatewayBaseURL, &http.Client{Timeout: 10 * time.Second})
	case "log":
		return runner.LogOTPSender{Log: log}
	case "fixed":
		if cfg.IsProd() {
			log.Warn("OTP sender is FIXED in prod: anyone knowing WERUN_OTP_FIXED_CODE can log in as any phone number; switch to telegram before real users arrive")
		}
		return runner.FixedOTPSender{Code: cfg.OTPFixedCode}
	default:
		// config.Load 已校验取值，这里不可达；真走到说明配置校验与本函数脱节了。
		panic(fmt.Sprintf("unknown OTP sender %q", cfg.OTPSenderKind()))
	}
}

// JobDeps 汇总 River worker 的依赖；serve --with-worker 与 worker 命令共用。
func (a *App) JobDeps() jobs.Deps {
	return jobs.Deps{
		Pool:     a.Pool,
		Log:      a.Log,
		Sessions: a.IAM,
		Notify:   &notify.SendWorker{Pool: a.Pool, Sender: newNotifySender(a.Cfg, a.Log), Log: a.Log},
		Deadline: &registration.DeadlineWorker{Svc: a.Registration, Log: a.Log},
	}
}
