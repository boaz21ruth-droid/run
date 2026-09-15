package main

import (
	"io"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/platform/config"
	"werun/api/internal/platform/logx"
	"werun/api/internal/registration"
)

func TestNewNotifySenderFollowsTelegramSendSetting(t *testing.T) {
	log := logx.New("error", io.Discard)
	cases := []struct {
		name         string
		cfg          config.Config
		wantTelegram bool
	}{
		{"prod 未设置时发送", config.Config{Env: "prod", TelegramBotToken: "1:x"}, true},
		{"dev 未设置时只写日志", config.Config{Env: "dev", TelegramBotToken: "1:x"}, false},
		{"dev 显式 on", config.Config{Env: "dev", TelegramSend: "on", TelegramBotToken: "1:x"}, true},
		{"prod 显式 off", config.Config{Env: "prod", TelegramSend: "off", TelegramBotToken: "1:x"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender := newNotifySender(tc.cfg, log)

			_, isTelegram := sender.(*notify.TelegramSender)
			_, isLog := sender.(notify.LogSender)
			require.Equal(t, tc.wantTelegram, isTelegram)
			require.Equal(t, !tc.wantTelegram, isLog)
		})
	}
}

func TestJobDepsIncludesNotifyAndDeadlineWorkers(t *testing.T) {
	app := &App{
		Cfg:          config.Config{Env: "dev"},
		Log:          logx.New("error", io.Discard),
		Registration: registration.NewService(nil, nil, nil, nil, time.Now),
	}

	deps := app.JobDeps()

	require.NotNil(t, deps.Notify)
	require.IsType(t, notify.LogSender{}, deps.Notify.Sender)
	require.Same(t, app.Log, deps.Notify.Log)
	require.Same(t, app.Log, deps.Log)
	require.NotNil(t, deps.Deadline)
	require.Same(t, app.Registration, deps.Deadline.Svc)
	require.Same(t, app.Log, deps.Deadline.Log)
}
