package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultTelegramBaseURL 是 Telegram Bot API 地址。
const DefaultTelegramBaseURL = "https://api.telegram.org"

// TelegramSender 通过 Bot API sendMessage 发送私信。
type TelegramSender struct {
	token   string
	baseURL string
	client  *http.Client
}

// NewTelegramSender 创建发送器；baseURL 为空时用 DefaultTelegramBaseURL，client 为 nil 时用 10 秒超时的客户端。
func NewTelegramSender(botToken, baseURL string, client *http.Client) *TelegramSender {
	if baseURL == "" {
		baseURL = DefaultTelegramBaseURL
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &TelegramSender{token: botToken, baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

type sendMessageRequest struct {
	ChatID      int64                 `json:"chat_id"`
	Text        string                `json:"text"`
	ReplyMarkup *inlineKeyboardMarkup `json:"reply_markup,omitempty"`
}

type inlineKeyboardMarkup struct {
	InlineKeyboard [][]inlineKeyboardButton `json:"inline_keyboard"`
}

type inlineKeyboardButton struct {
	Text   string     `json:"text"`
	WebApp webAppInfo `json:"web_app"`
}

type webAppInfo struct {
	URL string `json:"url"`
}

type apiResponse struct {
	OK          bool   `json:"ok"`
	ErrorCode   int    `json:"error_code"`
	Description string `json:"description"`
}

// Send 调用 sendMessage。403 返回包装了 ErrRecipientBlocked 的错误；其他非 2xx 或 ok=false 返回带 description 的错误。
func (s *TelegramSender) Send(ctx context.Context, chatID int64, text string, button *Button) error {
	body := sendMessageRequest{ChatID: chatID, Text: text}
	if button != nil {
		body.ReplyMarkup = &inlineKeyboardMarkup{InlineKeyboard: [][]inlineKeyboardButton{{
			{Text: button.Text, WebApp: webAppInfo{URL: button.URL}},
		}}}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("telegram sendMessage: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/bot"+s.token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("telegram sendMessage: build request: %w", s.redact(err))
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("telegram sendMessage: %w", s.redact(err))
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return fmt.Errorf("telegram sendMessage: read response (status %d): %w", resp.StatusCode, err)
	}
	var out apiResponse
	_ = json.Unmarshal(raw, &out) // 解析失败时 out.OK 为 false，下面按错误处理
	description := out.Description
	if description == "" {
		description = strings.TrimSpace(string(raw))
		if len(description) > 200 {
			description = description[:200]
		}
		description = strings.ToValidUTF8(description, "")
	}

	if resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w: %s", ErrRecipientBlocked, description)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 || !out.OK {
		return fmt.Errorf("telegram sendMessage: status %d: %s", resp.StatusCode, description)
	}
	return nil
}

// redact 去掉错误信息里的机器人 token（*url.Error 会带上完整 URL）。
func (s *TelegramSender) redact(err error) error {
	if s.token == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), s.token, "<redacted>"))
}
