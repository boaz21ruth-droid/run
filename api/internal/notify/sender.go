package notify

import (
	"context"
	"errors"
	"log/slog"
)

// Button 是消息下方的按钮：点击后在 Telegram 内打开小程序页面。
type Button struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

// Sender 发送一条 Telegram 私信。
type Sender interface {
	Send(ctx context.Context, chatID int64, text string, button *Button) error
}

// ErrRecipientBlocked 表示跑者屏蔽了机器人或从未与机器人对话（Telegram 返回 403）。
// 发送实现用 %w 包装它，调用方用 errors.Is 判断。
var ErrRecipientBlocked = errors.New("notify: recipient blocked the bot")

// LogSender 在 WERUN_TELEGRAM_SEND=off 时使用：只写日志，不调用 Telegram。
type LogSender struct{ Log *slog.Logger }

// Send 记录一条日志并返回 nil。
func (s LogSender) Send(ctx context.Context, chatID int64, text string, button *Button) error {
	attrs := []any{"chat_id", chatID, "text", text}
	if button != nil {
		attrs = append(attrs, "button_text", button.Text, "button_url", button.URL)
	}
	s.Log.InfoContext(ctx, "telegram send disabled; notification logged only", attrs...)
	return nil
}
