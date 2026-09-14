// Package httpx 提供 HTTP 层的公共能力：中间件、请求上下文取值与错误响应渲染。
package httpx

import (
	"context"

	"werun/api/internal/platform/i18n"
)

// gin 上下文键。gin.Context.Value 对字符串键会读取 c.Get 的值。
const (
	keyRequestID = "werun.request_id"
	keyLang      = "werun.lang"
)

// LangOf 返回当前请求的语言；没有设置时返回 i18n.Default。
func LangOf(ctx context.Context) i18n.Lang {
	if ctx != nil {
		if l, ok := ctx.Value(keyLang).(i18n.Lang); ok {
			return l
		}
	}
	return i18n.Default
}

// RequestIDOf 返回当前请求的请求 ID；没有设置时返回空字符串。
func RequestIDOf(ctx context.Context) string {
	if ctx != nil {
		if id, ok := ctx.Value(keyRequestID).(string); ok {
			return id
		}
	}
	return ""
}
