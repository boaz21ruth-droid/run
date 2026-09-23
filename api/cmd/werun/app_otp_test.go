package main

import (
	"log/slog"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/platform/config"
	"werun/api/internal/runner"
)

func TestNewOTPSenderByConfig(t *testing.T) {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	assert.IsType(t, runner.FixedOTPSender{}, newOTPSender(config.Config{Env: "dev"}, log))
	assert.IsType(t, runner.LogOTPSender{}, newOTPSender(config.Config{Env: "dev", OTPSender: "log"}, log))
	assert.IsType(t, runner.FixedOTPSender{}, newOTPSender(config.Config{Env: "prod", OTPSender: "fixed"}, log))
	assert.IsType(t, &runner.GatewaySender{}, newOTPSender(config.Config{Env: "prod", TelegramGatewayToken: "x"}, log))
	assert.Panics(t, func() { newOTPSender(config.Config{Env: "dev", OTPSender: "bogus"}, log) }, "配置校验漏网时必须炸掉，不能静默回退到固定码")
}
