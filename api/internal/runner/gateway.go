package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultGatewayBaseURL 是 Telegram Gateway 的正式地址。
const DefaultGatewayBaseURL = "https://gatewayapi.telegram.org"

// otpTTLSeconds 与 spec §2 的 5 分钟一致；Gateway 端到期后消息作废。
const otpTTLSeconds = 300

// GatewaySender 通过 Telegram Gateway 的 sendVerificationMessage 发送本系统生成的验证码。
type GatewaySender struct {
	token   string
	baseURL string
	client  *http.Client
}

func NewGatewaySender(token, baseURL string, client *http.Client) *GatewaySender {
	return &GatewaySender{token: token, baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

type gatewayRequest struct {
	PhoneNumber string `json:"phone_number"`
	Code        string `json:"code"`
	TTL         int    `json:"ttl"`
}

type gatewayResponse struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Result struct {
		RequestID string `json:"request_id"`
	} `json:"result"`
}

// 号码类错误码：Gateway 明确表示这个号码收不到消息。
var gatewayPhoneErrors = map[string]bool{
	"PHONE_NUMBER_INVALID":   true,
	"PHONE_NUMBER_NOT_FOUND": true,
	"USER_NOT_FOUND":         true,
	"PHONE_NUMBER_BANNED":    true,
}

func (s *GatewaySender) Send(ctx context.Context, phone, code string) (string, error) {
	body, err := json.Marshal(gatewayRequest{PhoneNumber: phone, Code: code, TTL: otpTTLSeconds})
	if err != nil {
		return "", fmt.Errorf("runner: gateway request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/sendVerificationMessage", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("runner: gateway request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", s.redact(fmt.Errorf("runner: gateway send to %s: %w", maskPhone(phone), err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", fmt.Errorf("runner: gateway send to %s: read response: %w", maskPhone(phone), err)
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("runner: gateway send to %s: HTTP %d", maskPhone(phone), resp.StatusCode)
	}
	var out gatewayResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("runner: gateway send to %s: decode: %w", maskPhone(phone), err)
	}
	if !out.OK {
		if gatewayPhoneErrors[out.Error] {
			return "", fmt.Errorf("%w: %s", ErrPhoneUnreachable, out.Error)
		}
		return "", fmt.Errorf("runner: gateway send to %s: %s", maskPhone(phone), out.Error)
	}
	return out.Result.RequestID, nil
}

// redact 把错误文本里可能出现的 token 抹掉（net/http 的错误会带完整 URL，这里 URL 不含 token，但保持与 notify 一致的防御）。
func (s *GatewaySender) redact(err error) error {
	if s.token == "" {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), s.token, "<redacted>"))
}
