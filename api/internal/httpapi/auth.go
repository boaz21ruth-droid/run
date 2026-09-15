package httpapi

import (
	"context"
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
	"werun/api/internal/runner"
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

// RunnerAuthenticator 校验跑者令牌，由 runner.Service 实现。
type RunnerAuthenticator interface {
	Authenticate(ctx context.Context, token string) (runner.User, error)
}

// AuthMiddleware 按 apigen.OperationAuths 做认证与权限校验：
//   - AuthApp 只认 Authorization: Bearer 跑者令牌，员工 Cookie 无效；
//   - AuthSession / AuthPermission 只认员工 Cookie，跑者令牌无效。
//
// 映射表里查不到的接口一律拒绝（说明忘了执行 make gen-api），并打一条 Warn 日志方便定位
// 是哪个接口、该跑哪条命令，而不是只在响应里看到一个不说明原因的 403。
func AuthMiddleware(staff *iam.Service, runners RunnerAuthenticator, auths map[string]apigen.OperationAuth, log *slog.Logger) apigen.StrictMiddlewareFunc {
	return func(next apigen.StrictHandlerFunc, operationID string) apigen.StrictHandlerFunc {
		rule, known := auths[operationID]
		if known && rule.Kind == apigen.AuthNone {
			return next
		}
		if known && rule.Kind == apigen.AuthApp {
			return func(c *gin.Context, request any) (any, error) {
				token := runner.BearerToken(c.Request)
				if token == "" {
					return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
				}
				user, err := runners.Authenticate(c, token)
				if err != nil {
					return nil, err
				}
				runner.WithUser(c, user)
				return next(c, request)
			}
		}
		return func(c *gin.Context, request any) (any, error) {
			if !known {
				log.WarnContext(c, "operation is missing from OperationAuths; run make gen-api",
					"operation", operationID)
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden).
					Wrap(fmt.Errorf("operation %s is missing from OperationAuths; run make gen-api", operationID))
			}
			token, err := c.Cookie(iam.CookieName)
			if err != nil || token == "" {
				return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
			}
			member, err := staff.Authenticate(c, token)
			if err != nil {
				return nil, err
			}
			iam.WithStaff(c, member)
			if rule.Kind == apigen.AuthPermission &&
				!iam.Allowed(member.Role, iam.Permission(rule.Permission), iam.Access(rule.Access)) {
				return nil, apperr.New(http.StatusForbidden, apperr.CodeForbidden)
			}
			// TODO(spec §5.1 step 7，赛事范围校验): 目前到这里为止只做了会话认证
			// 与按 x-permission 的角色权限校验；对 PHOTOGRAPHER / RACE_SUPERVISOR /
			// RACE_STAFF 这三个角色，spec 还要求当接口带赛事 ID 时，进一步校验该员工
			// 是否被指派到该赛事（`staff_event_assignments` 表，见
			// api/db/migrations/0002_events.sql）。本次 controller 决定暂不实现这一步，
			// 由后续任务在此处补一个中间件钩子：在放行 next(c, request) 之前，解析请求
			// 中的赛事 ID，查 staff_event_assignments 确认该员工在有效期内被指派到该
			// 赛事，否则返回 FORBIDDEN。在补齐之前，绝不能给这三个角色开放任何按赛事 ID
			// 访问的路由，否则他们将能访问未被指派的赛事数据。
			return next(c, request)
		}
	}
}
