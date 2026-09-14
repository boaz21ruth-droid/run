package iam

import (
	"context"

	"github.com/gin-gonic/gin"
)

// staffContextKey 是 gin 上下文键；gin.Context.Value 对字符串键会查 c.Get。
const staffContextKey = "werun.staff"

// WithStaff 由认证中间件调用，把当前员工放进请求上下文。
func WithStaff(c *gin.Context, s Staff) {
	c.Set(staffContextKey, s)
}

// StaffFrom 取出当前员工；ctx 为 *gin.Context 或其派生。
func StaffFrom(ctx context.Context) (Staff, bool) {
	if ctx == nil {
		return Staff{}, false
	}
	s, ok := ctx.Value(staffContextKey).(Staff)
	return s, ok
}
