package main

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/config"
	"werun/api/internal/runner"
)

func TestNewOTPSenderByConfig(t *testing.T) {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	assert.IsType(t, runner.FixedOTPSender{}, newOTPSender(config.Config{Env: "dev"}, log))
	assert.IsType(t, runner.LogOTPSender{}, newOTPSender(config.Config{Env: "dev", OTPSender: "log"}, log))
	assert.Equal(t, runner.FixedOTPSender{Code: "000000"}, newOTPSender(config.Config{Env: "prod", OTPSender: "fixed", OTPFixedCode: "000000"}, log))
	assert.IsType(t, &runner.GatewaySender{}, newOTPSender(config.Config{Env: "prod", TelegramGatewayToken: "x"}, log))
	assert.Panics(t, func() { newOTPSender(config.Config{Env: "dev", OTPSender: "bogus"}, log) }, "配置校验漏网时必须炸掉，不能静默回退到固定码")
}

// syncBuffer 让日志写入与断言读取不产生数据竞争。
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestFixedOTPInProdLogsErrorAtStartup(t *testing.T) {
	var out syncBuffer
	log := slog.New(slog.NewTextHandler(&out, nil))

	newOTPSender(config.Config{Env: "prod", OTPSender: "fixed", OTPFixedCode: "000000"}, log)

	assert.Contains(t, out.String(), "level=ERROR")
	assert.Contains(t, out.String(), "every phone number can be logged into")
}

func TestUsesFixedOTPInProd(t *testing.T) {
	assert.True(t, usesFixedOTPInProd(config.Config{Env: "prod", OTPSender: "fixed", OTPFixedCode: "000000"}))
	assert.False(t, usesFixedOTPInProd(config.Config{Env: "dev"}), "dev 默认 fixed 不告警")
	assert.False(t, usesFixedOTPInProd(config.Config{Env: "prod", TelegramGatewayToken: "x"}))
}

func TestRepeatFixedOTPAlarmRepeatsUntilCancelled(t *testing.T) {
	var out syncBuffer
	log := slog.New(slog.NewTextHandler(&out, nil))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		repeatFixedOTPAlarm(ctx, log, 5*time.Millisecond)
		close(done)
	}()

	require.Eventually(t, func() bool {
		return strings.Count(out.String(), "level=ERROR") >= 2
	}, 2*time.Second, 5*time.Millisecond, "告警必须定时重复")
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后告警循环必须退出")
	}
}
