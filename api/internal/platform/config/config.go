// Package config 从环境变量读取运行配置。所有变量以 WERUN_ 为前缀。
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/caarlos0/env/v11"
)

// Config 是 werun 进程的全部运行配置。
type Config struct {
	Env                 string `env:"WERUN_ENV" envDefault:"dev"`
	HTTPAddr            string `env:"WERUN_HTTP_ADDR" envDefault:":8080"`
	DatabaseURL         string `env:"WERUN_DATABASE_URL,required"`
	SessionSecret       string `env:"WERUN_SESSION_SECRET,required"`
	PIIKey              string `env:"WERUN_PII_KEY,required"`
	FilesDir            string `env:"WERUN_FILES_DIR" envDefault:"./data/files"`
	LogLevel            string `env:"WERUN_LOG_LEVEL" envDefault:"info"`
	TelegramBotToken    string `env:"WERUN_TELEGRAM_BOT_TOKEN,required"`
	TelegramBotUsername string `env:"WERUN_TELEGRAM_BOT_USERNAME,required"`
	TelegramSend        string `env:"WERUN_TELEGRAM_SEND"` // "" | on | off
	AppBaseURL          string `env:"WERUN_APP_BASE_URL,required"`
}

// Load 解析并校验环境变量。返回的错误会列出所有不合法的变量，而不是只报第一个。
func Load() (Config, error) {
	cfg, err := env.ParseAs[Config]()

	var errs []error
	if err != nil {
		errs = append(errs, err)
	}
	if cfg.Env != "dev" && cfg.Env != "prod" {
		errs = append(errs, fmt.Errorf("WERUN_ENV must be dev or prod, got %q", cfg.Env))
	}
	if cfg.SessionSecret != "" && len(cfg.SessionSecret) < 32 {
		errs = append(errs, errors.New("WERUN_SESSION_SECRET must be at least 32 bytes"))
	}
	if cfg.PIIKey != "" {
		if _, keyErr := cfg.PIIKeyBytes(); keyErr != nil {
			errs = append(errs, keyErr)
		}
	}
	// required 只要求变量存在；设置为空串或空白时也必须拒绝：空 bot token 会让 initData 的
	// secret 变成公开常量 HMAC("WebAppData", "")，任何人都能伪造跑者登录。
	cfg.TelegramBotToken = strings.TrimSpace(cfg.TelegramBotToken)
	cfg.TelegramBotUsername = strings.TrimSpace(cfg.TelegramBotUsername)
	for name, value := range map[string]string{
		"WERUN_TELEGRAM_BOT_TOKEN":    cfg.TelegramBotToken,
		"WERUN_TELEGRAM_BOT_USERNAME": cfg.TelegramBotUsername,
	} {
		// 变量未设置时 env.ParseAs 已经报过，不重复报
		if value == "" && (err == nil || !strings.Contains(err.Error(), name)) {
			errs = append(errs, fmt.Errorf("%s must not be empty", name))
		}
	}
	if cfg.TelegramSend != "" && cfg.TelegramSend != "on" && cfg.TelegramSend != "off" {
		errs = append(errs, fmt.Errorf("WERUN_TELEGRAM_SEND must be on, off or empty, got %q", cfg.TelegramSend))
	}
	// 变量未设置时 env.ParseAs 已经报过 WERUN_APP_BASE_URL，不重复报
	if err == nil || !strings.Contains(err.Error(), "WERUN_APP_BASE_URL") {
		if baseErr := validateBaseURL(cfg.AppBaseURL); baseErr != nil {
			errs = append(errs, baseErr)
		}
	}
	cfg.AppBaseURL = strings.TrimRight(cfg.AppBaseURL, "/")
	if len(errs) > 0 {
		return Config{}, errors.Join(errs...)
	}
	return cfg, nil
}

// IsProd 表示是否运行在生产环境。
func (c Config) IsProd() bool {
	return c.Env == "prod"
}

// PIIKeyBytes 返回解码后的 32 字节个人信息加密密钥。
func (c Config) PIIKeyBytes() ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(c.PIIKey)
	if err != nil {
		return nil, fmt.Errorf("WERUN_PII_KEY must be standard base64: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("WERUN_PII_KEY must decode to 32 bytes, got %d", len(key))
	}
	return key, nil
}

// TelegramSendEnabled 表示推送是否真正调用 Telegram：显式 on/off 优先，未设置时只有 prod 发送。
func (c Config) TelegramSendEnabled() bool {
	switch c.TelegramSend {
	case "on":
		return true
	case "off":
		return false
	default:
		return c.IsProd()
	}
}

func validateBaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("WERUN_APP_BASE_URL must be an absolute http(s) URL, got %q", raw)
	}
	return nil
}
