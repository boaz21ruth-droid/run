// Package httpx 提供 HTTP 层的公共能力：中间件、请求上下文取值与错误响应渲染。
package httpx

import (
	"context"

	"github.com/gin-gonic/gin"

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

// Meta 是写审计记录时需要的请求信息。
type Meta struct {
	RequestID string
	IP        string
	UserAgent string
}

// MetaOf 从请求上下文中取出请求 ID、客户端 IP 与 User-Agent；不是 gin 请求时只返回能取到的部分。
func MetaOf(ctx context.Context) Meta {
	m := Meta{RequestID: RequestIDOf(ctx)}
	if c, ok := Gin(ctx); ok && c.Request != nil {
		m.IP = c.ClientIP()
		m.UserAgent = c.Request.UserAgent()
	}
	return m
}

// Gin 取回 *gin.Context。oapi-codegen strict handler 收到的 ctx 实参就是 *gin.Context。
func Gin(ctx context.Context) (*gin.Context, bool) {
	if ctx == nil {
		return nil, false
	}
	if c, ok := ctx.(*gin.Context); ok {
		return c, true
	}
	if c, ok := ctx.Value(gin.ContextKey).(*gin.Context); ok {
		return c, true
	}
	return nil, false
}
