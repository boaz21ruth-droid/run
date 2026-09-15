package main

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/runner"
)

const devTestBotToken = "123456:dev-initdata-test-token"

// setDevConfigEnv 设置 config.Load 需要的全部变量；dev-initdata 不连接数据库。
func setDevConfigEnv(t *testing.T) {
	t.Helper()
	t.Setenv("WERUN_ENV", "dev")
	t.Setenv("WERUN_DATABASE_URL", "postgres://werun:werun@localhost:55432/werun?sslmode=disable")
	t.Setenv("WERUN_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("WERUN_PII_KEY", "ZGV2LW9ubHktcGlpLWtleS0zMi1ieXRlcy0wMDAwMDA=")
	t.Setenv("WERUN_TELEGRAM_BOT_TOKEN", devTestBotToken)
	t.Setenv("WERUN_TELEGRAM_BOT_USERNAME", "werun_e2e_bot")
	t.Setenv("WERUN_TELEGRAM_SEND", "off")
	t.Setenv("WERUN_APP_BASE_URL", "http://werun.localhost")
}

func TestDevInitDataPrintsVerifiableInitData(t *testing.T) {
	setDevConfigEnv(t)

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10001", "--name", "Sokha Chan", "--lang", "km")

	require.Equal(t, 0, code, stderr)
	got, err := runner.VerifyInitData(strings.TrimSpace(stdout), devTestBotToken, time.Now())
	require.NoError(t, err)
	assert.Equal(t, runner.TelegramUser{ID: 10001, FirstName: "Sokha Chan", LanguageCode: "km"}, got)
}

func TestDevInitDataDefaultsLangToEnglish(t *testing.T) {
	setDevConfigEnv(t)

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10002", "--name", "Dara")

	require.Equal(t, 0, code, stderr)
	got, err := runner.VerifyInitData(strings.TrimSpace(stdout), devTestBotToken, time.Now())
	require.NoError(t, err)
	assert.Equal(t, "en", got.LanguageCode)
}

func TestDevInitDataRefusesInProd(t *testing.T) {
	setDevConfigEnv(t)
	t.Setenv("WERUN_ENV", "prod")

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10001", "--name", "Dara")

	assert.Equal(t, 1, code)
	assert.Empty(t, stdout)
	assert.Contains(t, stderr, "WERUN_ENV=prod")
}

func TestDevInitDataRefusesBlankBotToken(t *testing.T) {
	setDevConfigEnv(t)
	t.Setenv("WERUN_TELEGRAM_BOT_TOKEN", "  ")

	code, stdout, stderr := runCmd("dev-initdata", "--telegram-id", "10001", "--name", "Dara")

	assert.Equal(t, 1, code)
	assert.Empty(t, stdout)
	assert.Contains(t, stderr, "WERUN_TELEGRAM_BOT_TOKEN")
}

func TestDevInitDataValidatesFlags(t *testing.T) {
	setDevConfigEnv(t)
	cases := map[string]struct {
		args []string
		want string
	}{
		"missing telegram id":  {[]string{"--name", "Dara"}, "--telegram-id"},
		"negative telegram id": {[]string{"--telegram-id", "-5", "--name", "Dara"}, "--telegram-id"},
		"missing name":         {[]string{"--telegram-id", "10001"}, "--name"},
		"blank name":           {[]string{"--telegram-id", "10001", "--name", "   "}, "--name"},
		"unknown lang":         {[]string{"--telegram-id", "10001", "--name", "Dara", "--lang", "fr"}, "--lang"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := runCmd(append([]string{"dev-initdata"}, tc.args...)...)
			assert.Equal(t, 1, code)
			assert.Empty(t, stdout)
			assert.Contains(t, stderr, tc.want)
		})
	}
}
