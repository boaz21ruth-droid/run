package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"werun/api/internal/platform/config"
	"werun/api/internal/runner"
)

var (
	devInitDataLangs     = []string{"zh", "en", "km"}
	errDevInitDataInProd = errors.New("WERUN_ENV=prod 时禁止生成开发登录参数")
)

// runDevInitData 实现 `werun dev-initdata`：用配置里的机器人 token 生成签名正确的 initData 并打印一行。
func runDevInitData(args []string, stdout, stderr io.Writer) error {
	// 先看原始环境变量：生产环境即使配置不全也必须拒绝
	if os.Getenv("WERUN_ENV") == "prod" {
		return errDevInitDataInProd
	}
	fs := flag.NewFlagSet("dev-initdata", flag.ContinueOnError)
	fs.SetOutput(stderr)
	telegramID := fs.Int64("telegram-id", 0, "Telegram 用户 ID（正整数）")
	name := fs.String("name", "", "显示名，写入 user.first_name")
	lang := fs.String("lang", "en", "language_code："+strings.Join(devInitDataLangs, " | "))
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *telegramID <= 0 {
		return errors.New("--telegram-id 必须是正整数")
	}
	displayName := strings.TrimSpace(*name)
	if displayName == "" {
		return errors.New("--name 不能为空")
	}
	if !slices.Contains(devInitDataLangs, *lang) {
		return fmt.Errorf("--lang 只能是 %s", strings.Join(devInitDataLangs, "、"))
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if cfg.IsProd() {
		return errDevInitDataInProd
	}
	initData := runner.SignInitData(cfg.TelegramBotToken, runner.TelegramUser{
		ID:           *telegramID,
		FirstName:    displayName,
		LanguageCode: *lang,
	}, time.Now())
	_, err = fmt.Fprintln(stdout, initData)
	return err
}
