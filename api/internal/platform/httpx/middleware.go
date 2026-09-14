package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/gin-gonic/gin"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// 请求头。
const (
	HeaderRequestID = "X-Request-ID"
	HeaderClient    = "X-WeRun-Client"
)

// RequestID 读取合法的 X-Request-ID（1–64 位字母、数字、- 或 _），否则生成 16 位十六进制 ID；
// 写入上下文并回写到响应头。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(HeaderRequestID)
		if !validRequestID(id) {
			id = newRequestID()
		}
		c.Set(keyRequestID, id)
		c.Header(HeaderRequestID, id)
		c.Next()
	}
}

func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// AccessLog 在请求结束后写一条访问日志。
func AccessLog(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.InfoContext(c, "http request",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", RequestIDOf(c),
			"ip", c.ClientIP(),
		)
	}
}

// Recover 捕获 handler 中的 panic，记录堆栈并返回 500 INTERNAL。
func Recover(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			p := recover()
			if p == nil {
				return
			}
			if err, ok := p.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(p)
			}
			log.ErrorContext(c, "panic recovered",
				"panic", fmt.Sprint(p),
				"stack", string(debug.Stack()),
				"request_id", RequestIDOf(c),
			)
			WriteError(c, cat, log, apperr.New(http.StatusInternalServerError, apperr.CodeInternal).
				Wrap(fmt.Errorf("panic: %v", p)))
		}()
		c.Next()
	}
}

// Locale 按 ?lang= → Accept-Language → km 确定语言并写入上下文。
func Locale() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(keyLang, i18n.FromRequest(c.Query("lang"), c.GetHeader("Accept-Language")))
		c.Next()
	}
}
