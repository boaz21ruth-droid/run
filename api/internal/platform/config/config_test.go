package config_test

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/config"
)

// base64("dev-only-pii-key-32-bytes-000000")，解码后正好 32 字节
const validPIIKey = "ZGV2LW9ubHktcGlpLWtleS0zMi1ieXRlcy0wMDAwMDA="

// unset 让变量在本测试内处于"未设置"状态，测试结束后自动恢复原值。
func unset(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		t.Setenv(k, "")
		require.NoError(t, os.Unsetenv(k))
	}
}

func setRequired(t *testing.T) {
	t.Helper()
	unset(t, "WERUN_ENV", "WERUN_HTTP_ADDR", "WERUN_FILES_DIR", "WERUN_LOG_LEVEL", "WERUN_TELEGRAM_SEND")
	t.Setenv("WERUN_DATABASE_URL", "postgres://werun:werun@localhost:55432/werun?sslmode=disable")
	t.Setenv("WERUN_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("WERUN_PII_KEY", validPIIKey)
	t.Setenv("WERUN_TELEGRAM_BOT_TOKEN", "123456:e2e-test-token")
	t.Setenv("WERUN_TELEGRAM_BOT_USERNAME", "werun_e2e_bot")
	t.Setenv("WERUN_APP_BASE_URL", "http://werun.localhost")
}

func TestLoadAppliesDefaults(t *testing.T) {
	setRequired(t)

	cfg, err := config.Load()

	require.NoError(t, err)
	assert.Equal(t, "dev", cfg.Env)
	assert.Equal(t, ":8080", cfg.HTTPAddr)
	assert.Equal(t, "./data/files", cfg.FilesDir)
	assert.Equal(t, "info", cfg.LogLevel)
	assert.False(t, cfg.IsProd())
	assert.Equal(t, "123456:e2e-test-token", cfg.TelegramBotToken)
	assert.Equal(t, "werun_e2e_bot", cfg.TelegramBotUsername)
	assert.Equal(t, "", cfg.TelegramSend)
	assert.Equal(t, "http://werun.localhost", cfg.AppBaseURL)
	assert.False(t, cfg.TelegramSendEnabled(), "dev 默认不发送")
}

func TestLoadProd(t *testing.T) {
	setRequired(t)
	t.Setenv("WERUN_ENV", "prod")

	cfg, err := config.Load()

	require.NoError(t, err)
	assert.True(t, cfg.IsProd())
}

func TestLoadReportsEveryInvalidVariable(t *testing.T) {
	unset(t, "WERUN_DATABASE_URL", "WERUN_HTTP_ADDR", "WERUN_FILES_DIR", "WERUN_LOG_LEVEL",
		"WERUN_TELEGRAM_BOT_TOKEN", "WERUN_TELEGRAM_BOT_USERNAME", "WERUN_APP_BASE_URL")
	t.Setenv("WERUN_ENV", "staging")
	t.Setenv("WERUN_SESSION_SECRET", "too-short")
	t.Setenv("WERUN_PII_KEY", "not base64 !!")
	t.Setenv("WERUN_TELEGRAM_SEND", "yes")

	_, err := config.Load()

	require.Error(t, err)
	for _, name := range []string{
		"WERUN_DATABASE_URL", "WERUN_ENV", "WERUN_SESSION_SECRET", "WERUN_PII_KEY",
		"WERUN_TELEGRAM_BOT_TOKEN", "WERUN_TELEGRAM_BOT_USERNAME", "WERUN_APP_BASE_URL", "WERUN_TELEGRAM_SEND",
	} {
		assert.Contains(t, err.Error(), name)
	}
}

func TestLoadRejectsPIIKeyOfWrongLength(t *testing.T) {
	setRequired(t)
	t.Setenv("WERUN_PII_KEY", "c2hvcnQta2V5LTE2LWJ5dGU=") // base64("short-key-16-byte")

	_, err := config.Load()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "WERUN_PII_KEY")
}

func TestPIIKeyBytes(t *testing.T) {
	setRequired(t)
	cfg, err := config.Load()
	require.NoError(t, err)

	key, err := cfg.PIIKeyBytes()

	require.NoError(t, err)
	assert.Len(t, key, 32)
}

func TestTelegramSendEnabled(t *testing.T) {
	cases := []struct {
		env, send string
		want      bool
	}{
		{"dev", "", false},
		{"prod", "", true},
		{"dev", "on", true},
		{"prod", "off", false},
	}
	for _, tc := range cases {
		t.Run(tc.env+"/"+tc.send, func(t *testing.T) {
			setRequired(t)
			t.Setenv("WERUN_ENV", tc.env)
			if tc.send != "" {
				t.Setenv("WERUN_TELEGRAM_SEND", tc.send)
			}

			cfg, err := config.Load()

			require.NoError(t, err)
			assert.Equal(t, tc.want, cfg.TelegramSendEnabled())
		})
	}
}

func TestLoadValidatesAppBaseURL(t *testing.T) {
	for _, bad := range []string{"", "werun.localhost", "ftp://werun.localhost", "http://"} {
		t.Run(bad, func(t *testing.T) {
			setRequired(t)
			t.Setenv("WERUN_APP_BASE_URL", bad)

			_, err := config.Load()

			require.Error(t, err)
			assert.Contains(t, err.Error(), "WERUN_APP_BASE_URL")
		})
	}

	setRequired(t)
	t.Setenv("WERUN_APP_BASE_URL", "https://app.werun.asia/")
	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "https://app.werun.asia", cfg.AppBaseURL, "去掉结尾斜杠，便于拼接 /orders/<orderNo>")
}
