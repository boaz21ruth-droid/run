package config_test

import (
	"os"
	"strconv"
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
	t.Setenv("WERUN_TELEGRAM_GATEWAY_TOKEN", "gw-test-token") // prod 默认发送器为 telegram，需要此项才合法
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
	t.Setenv("WERUN_APP_BASE_URL", "https://app.werun.asia")

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

// 变量已设置但为空（或只有空白）时也必须拒绝：空 bot token 会让 initData 的 secret 变成
// 公开常量 HMAC("WebAppData", "")，任何人都能伪造跑者登录。
func TestLoadRejectsBlankTelegramBotSettings(t *testing.T) {
	for _, name := range []string{"WERUN_TELEGRAM_BOT_TOKEN", "WERUN_TELEGRAM_BOT_USERNAME"} {
		for _, blank := range []string{"", "   ", "\t\n"} {
			t.Run(name+"/"+strconv.Quote(blank), func(t *testing.T) {
				setRequired(t)
				t.Setenv(name, blank)

				_, err := config.Load()

				require.Error(t, err)
				assert.Contains(t, err.Error(), name)
			})
		}
	}
}

func TestLoadTrimsTelegramBotSettings(t *testing.T) {
	setRequired(t)
	t.Setenv("WERUN_TELEGRAM_BOT_TOKEN", " 123456:e2e-test-token\n")
	t.Setenv("WERUN_TELEGRAM_BOT_USERNAME", " werun_e2e_bot ")

	cfg, err := config.Load()

	require.NoError(t, err)
	assert.Equal(t, "123456:e2e-test-token", cfg.TelegramBotToken)
	assert.Equal(t, "werun_e2e_bot", cfg.TelegramBotUsername)
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
			t.Setenv("WERUN_APP_BASE_URL", "https://app.werun.asia") // prod 只接受 https
			if tc.send != "" {
				t.Setenv("WERUN_TELEGRAM_SEND", tc.send)
			}

			cfg, err := config.Load()

			require.NoError(t, err)
			assert.Equal(t, tc.want, cfg.TelegramSendEnabled())
		})
	}
}

// Telegram 的 web_app 按钮只接受 https 地址：prod 下 http 基址会让每条推送都被 Telegram 400 拒绝。
func TestLoadAppBaseURLSchemeByEnv(t *testing.T) {
	cases := []struct {
		env, url string
		wantErr  bool
	}{
		{"prod", "http://app.werun.asia", true},
		{"prod", "https://app.werun.asia", false},
		{"dev", "http://werun.localhost", false},
		{"dev", "https://werun.localhost", false},
	}
	for _, tc := range cases {
		t.Run(tc.env+"/"+tc.url, func(t *testing.T) {
			setRequired(t)
			t.Setenv("WERUN_ENV", tc.env)
			t.Setenv("WERUN_APP_BASE_URL", tc.url)

			cfg, err := config.Load()

			if tc.wantErr {
				require.Error(t, err)
				assert.Contains(t, err.Error(), "WERUN_APP_BASE_URL")
				assert.Contains(t, err.Error(), "https")
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.url, cfg.AppBaseURL)
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

func TestLoadOTPSenderDefaults(t *testing.T) {
	setRequired(t)
	unset(t, "WERUN_OTP_SENDER", "WERUN_TELEGRAM_GATEWAY_TOKEN")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "fixed", cfg.OTPSenderKind(), "dev 默认 fixed")
}

func TestLoadOTPSenderProd(t *testing.T) {
	cases := []struct {
		name, sender, token string
		wantErr             string
	}{
		{name: "prod 默认 telegram 但缺 token", wantErr: "WERUN_TELEGRAM_GATEWAY_TOKEN"},
		{name: "prod 拒绝 fixed", sender: "fixed", token: "gw", wantErr: "WERUN_OTP_SENDER"},
		{name: "prod 拒绝 log", sender: "log", token: "gw", wantErr: "WERUN_OTP_SENDER"},
		{name: "prod telegram 有 token", sender: "telegram", token: "gw"},
		{name: "非法值", sender: "sms", token: "gw", wantErr: "WERUN_OTP_SENDER"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setRequired(t)
			unset(t, "WERUN_OTP_SENDER", "WERUN_TELEGRAM_GATEWAY_TOKEN")
			t.Setenv("WERUN_ENV", "prod")
			t.Setenv("WERUN_APP_BASE_URL", "https://suosdey.top")
			if tc.sender != "" {
				t.Setenv("WERUN_OTP_SENDER", tc.sender)
			}
			if tc.token != "" {
				t.Setenv("WERUN_TELEGRAM_GATEWAY_TOKEN", tc.token)
			}
			cfg, err := config.Load()
			if tc.wantErr == "" {
				require.NoError(t, err)
				assert.Equal(t, "telegram", cfg.OTPSenderKind())
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
		})
	}
}

func TestLoadOTPFixedCode(t *testing.T) {
	cases := []struct {
		name, env, sender, code, token string
		wantErr                        string
		wantCode                       string
	}{
		{name: "prod fixed 需要固定码", env: "prod", sender: "fixed", wantErr: "WERUN_OTP_FIXED_CODE"},
		{name: "prod fixed 带固定码放行", env: "prod", sender: "fixed", code: "000000", wantCode: "000000"},
		{name: "prod log 仍禁止", env: "prod", sender: "log", code: "000000", token: "gw", wantErr: "WERUN_OTP_SENDER=log"},
		{name: "固定码必须 6 位数字", env: "dev", sender: "fixed", code: "12ab", wantErr: "WERUN_OTP_FIXED_CODE"},
		{name: "dev 固定码可选", env: "dev", sender: "fixed", wantCode: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setRequired(t)
			unset(t, "WERUN_OTP_SENDER", "WERUN_TELEGRAM_GATEWAY_TOKEN", "WERUN_OTP_FIXED_CODE")
			t.Setenv("WERUN_ENV", tc.env)
			if tc.env == "prod" {
				t.Setenv("WERUN_APP_BASE_URL", "https://suosdey.top")
			}
			t.Setenv("WERUN_OTP_SENDER", tc.sender)
			if tc.code != "" {
				t.Setenv("WERUN_OTP_FIXED_CODE", tc.code)
			}
			if tc.token != "" {
				t.Setenv("WERUN_TELEGRAM_GATEWAY_TOKEN", tc.token)
			}
			cfg, err := config.Load()
			if tc.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.wantCode, cfg.OTPFixedCode)
		})
	}
}
