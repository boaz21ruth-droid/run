// Package config 从环境变量读取运行配置。所有变量以 WERUN_ 为前缀。
package config

import (
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/caarlos0/env/v11"
)

// Config 是 werun 进程的全部运行配置。
type Config struct {
	Env           string `env:"WERUN_ENV" envDefault:"dev"`
	HTTPAddr      string `env:"WERUN_HTTP_ADDR" envDefault:":8080"`
	DatabaseURL   string `env:"WERUN_DATABASE_URL,required"`
	SessionSecret string `env:"WERUN_SESSION_SECRET,required"`
	PIIKey        string `env:"WERUN_PII_KEY,required"`
	FilesDir      string `env:"WERUN_FILES_DIR" envDefault:"./data/files"`
	LogLevel      string `env:"WERUN_LOG_LEVEL" envDefault:"info"`
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
