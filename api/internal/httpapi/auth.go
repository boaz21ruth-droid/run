package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

const adminPathPrefix = "/api/admin/"

// CSRFGuard：/api/admin/ 下除 GET、HEAD 外的请求必须带 X-WeRun-Client: admin（含登录接口）。
func CSRFGuard(cat *i18n.Catalog, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		method := c.Request.Method
		if strings.HasPrefix(c.Request.URL.Path, adminPathPrefix) &&
			method != http.MethodGet && method != http.MethodHead &&
			c.GetHeader(httpx.HeaderClient) != "admin" {
			httpx.WriteError(c, cat, log, apperr.New(http.StatusForbidden, apperr.CodeCSRF))
			c.Abort()
			return
		}
		c.Next()
	}
}

// AuthMiddleware 按 apigen.OperationAuths 做会话认证与权限校验。
// 映射表里查不到的接口一律拒绝（说明忘了执行 make gen-api）。
func AuthMiddleware(svc *iam.Service, auths map[string]apigen.OperationAuth) apigen.StrictMiddlewareFunc {
	return func(next apigen.StrictHandlerFunc, operationID string) apigen.StrictHandlerFunc {
		rule, known := auths[operationID]
		if known && rule.Kind == apigen.AuthNone {
			return next
		}
		return func(c *gin.Context, request any) (any, error) {
			if !known {
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden).
					Wrap(fmt.Errorf("operation %s is missing from OperationAuths; run make gen-api", operationID))
			}
			token, err := c.Cookie(iam.CookieName)
			if err != nil || token == "" {
				return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
			}
			staff, err := svc.Authenticate(c, token)
			if err != nil {
				return nil, err
			}
			iam.WithStaff(c, staff)
			if rule.Kind == apigen.AuthPermission &&
				!iam.Allowed(staff.Role, iam.Permission(rule.Permission), iam.Access(rule.Access)) {
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden)
			}
			return next(c, request)
		}
	}
}
