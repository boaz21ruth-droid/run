package runner

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// userContextKey 是 gin 上下文键；gin.Context.Value 对字符串键会查 c.Get。
const userContextKey = "werun.runner"

// WithUser 由认证中间件调用，把当前跑者放进请求上下文。
func WithUser(c *gin.Context, u User) {
	c.Set(userContextKey, u)
}

// UserFrom 取出当前跑者；ctx 为 *gin.Context 或其派生。
func UserFrom(ctx context.Context) (User, bool) {
	if ctx == nil {
		return User{}, false
	}
	u, ok := ctx.Value(userContextKey).(User)
	return u, ok
}

// BearerToken 读取 Authorization: Bearer <token>，scheme 大小写不敏感；取不到时返回空串。
func BearerToken(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}
