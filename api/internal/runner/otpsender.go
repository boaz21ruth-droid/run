package runner

import (
	"context"
	"errors"
	"log/slog"
)

// OTPSender 把验证码送到手机号。payload 是本系统的 auth_otps 主键（十进制字符串），
// 原样透传给渠道，回执与对账时用它反查本地记录。返回的 providerRequestID 用于对账，可为空。
// 返回 ErrPhoneUnreachable 表示号码不可达（例如未注册 Telegram），其余错误视为通道故障。
type OTPSender interface {
	Send(ctx context.Context, phone, code, payload string) (providerRequestID string, err error)
}

// ErrPhoneUnreachable 表示号码不可达。
var ErrPhoneUnreachable = errors.New("runner: phone unreachable")

// FixedOTPCode 是 FixedOTPSender 生效时的固定验证码，只用于本地开发与端到端测试。
const FixedOTPCode = "123456"

// LogOTPSender 只把验证码写进日志。
type LogOTPSender struct{ Log *slog.Logger }

func (s LogOTPSender) Send(ctx context.Context, phone, code, payload string) (string, error) {
	s.Log.InfoContext(ctx, "otp code (log sender)", "phone", maskPhone(phone), "code", code, "payload", payload)
	return "", nil
}

// FixedOTPSender 不发送任何东西；Service 在它生效时把验证码固定为 FixedOTPCode。
type FixedOTPSender struct{}

func (FixedOTPSender) Send(context.Context, string, string, string) (string, error) {
	return "", nil
}

// maskPhone 保留国家码与后 3 位：+855********678 → 日志与错误信息里使用。
func maskPhone(phone string) string {
	if len(phone) <= 7 {
		return "***"
	}
	return phone[:4] + "***" + phone[len(phone)-3:]
}
