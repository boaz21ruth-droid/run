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
	// Payload 是 Gateway 原样回传的自定义字段（文档 https://core.telegram.org/gateway/api
	// 的 sendVerificationMessage：payload / "Custom payload, 0-128 bytes"），这里放
	// auth_otps 的主键，便于用回执反查本地验证码记录。
	Payload string `json:"payload"`
}

type gatewayResponse struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Result struct {
		RequestID string `json:"request_id"`
	} `json:"result"`
}

// 号码类错误码：Gateway 明确表示这个号码收不到消息，这类错误映射成 ErrPhoneUnreachable，
// 对用户提示“换个号码”，其余错误一律按通道故障处理（502）。
//
// 注意：官方文档 https://core.telegram.org/gateway/api（2026-09 查阅）只说明
// “ok=false 时错误写在 error 字段（例如 ACCESS_TOKEN_INVALID）”，并没有给出完整的
// 错误码清单，https://core.telegram.org/gateway/verification-tutorial 与
// https://core.telegram.org/gateway 同样没有。因此下面这几个码是按 Telegram 一贯
// 的命名约定推断的，未经官方文档验证；未命中的错误码会落到通道故障分支（更保守：
// 提示稍后重试而不是让用户换号码），所以清单不全不会造成安全或数据问题。
var gatewayPhoneErrors = map[string]bool{
	"PHONE_NUMBER_INVALID":   true,
	"PHONE_NUMBER_NOT_FOUND": true,
	"USER_NOT_FOUND":         true,
	"PHONE_NUMBER_BANNED":    true,
}

func (s *GatewaySender) Send(ctx context.Context, phone, code, payload string) (string, error) {
	body, err := json.Marshal(gatewayRequest{PhoneNumber: phone, Code: code, TTL: otpTTLSeconds, Payload: payload})
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
