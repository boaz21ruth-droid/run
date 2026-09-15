package httpapi

import (
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/event"
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/notify"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

// 请求体上限：没有上限的话，一个超大请求体在被参数校验拒绝之前就要被完整读入内存
// （且可能先跑到 argon2 这类昂贵的处理之前），本身就是一种放大攻击。
const (
	maxRequestBodyBytes = 1 << 20 // 1 MiB：普通 JSON 接口
	maxUploadBodyBytes  = 6 << 20 // 6 MiB：凭证截图（≤ 5 MB）与收款二维码（≤ 2 MB）的 multipart 接口
)

var uploadBodyPath = regexp.MustCompile(`^(?:/api/app/orders/[^/]+/proofs|/api/admin/payment-accounts(?:/[0-9]+)?)$`)

// bodyLimitFor 返回路径对应的请求体上限。
func bodyLimitFor(path string) int64 {
	if uploadBodyPath.MatchString(path) {
		return maxUploadBodyBytes
	}
	return maxRequestBodyBytes
}

// maxBodySize 给 /api/* 下的请求包一层 http.MaxBytesReader；超出大小时后续的 body 读取
// （如 ShouldBindJSON）会失败，经由 apigen 的 RequestErrorHandlerFunc 转成 BAD_REQUEST，
// 上传接口读图片时由 storage.ReadImage 转成 FILE_TOO_LARGE。
func maxBodySize() gin.HandlerFunc {
	return func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, bodyLimitFor(c.Request.URL.Path))
		}
		c.Next()
	}
}

// RouterDeps 是构造 HTTP 路由所需的依赖。
type RouterDeps struct {
	Log          *slog.Logger
	Catalog      *i18n.Catalog
	Pool         *pgxpool.Pool
	IAM          *iam.Service
	Runner       *runner.Service // 跑者登录与会话、常用参赛人、同意书
	Events       *event.Service
	Pricing      *pricing.Service
	Registration *registration.Service // 跑者算价与下单
	Payment      *payment.Service
	Notify       *notify.Service // Task 20：推送登记（后续 HTTP 路径直接触发推送时使用）
	Server       *Server         // 为 nil 时由 NewServer 构造
	Env          string          // "dev" | "prod"
}

// trustedProxies：只信任本机与私有网段（compose 网络里的 Caddy）转发的 X-Forwarded-For，
// 这样 c.ClientIP() 才是真实客户端 IP，登录限流按人计算。以后在 Caddy 前面加 Cloudflare 时，由 Caddy 的 trusted_proxies 处理。
var trustedProxies = []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// NewRouter 组装中间件与 apigen 生成的路由，所有接口挂在 /api 下。
func NewRouter(d RouterDeps) *gin.Engine {
	engine := gin.New()
	if err := engine.SetTrustedProxies(trustedProxies); err != nil {
		panic(err) // 列表是常量，出错说明代码写错了
	}
	engine.Use(
		maxBodySize(),
		httpx.RequestID(),
		httpx.AccessLog(d.Log),
		httpx.Recover(d.Catalog, d.Log),
		httpx.Locale(),
		CSRFGuard(d.Catalog, d.Log),
	)

	server := d.Server
	if server == nil {
		server = NewServer(d)
	}

	writeErr := func(c *gin.Context, err error) {
		httpx.WriteError(c, d.Catalog, d.Log, err)
	}
	middlewares := []apigen.StrictMiddlewareFunc{
		AuthMiddleware(d.IAM, d.Runner, apigen.OperationAuths, d.Log),
	}
	strict := apigen.NewStrictHandlerWithOptions(server, middlewares, apigen.StrictGinServerOptions{
		RequestErrorHandlerFunc: func(c *gin.Context, err error) {
			writeErr(c, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest).Wrap(err))
		},
		HandlerErrorFunc:         writeErr,
		ResponseErrorHandlerFunc: writeErr,
	})
	apigen.RegisterHandlersWithOptions(engine, strict, apigen.GinServerOptions{
		BaseURL: "/api",
		ErrorHandler: func(c *gin.Context, err error, status int) {
			writeErr(c, apperr.New(status, apperr.CodeBadRequest).Wrap(err))
		},
	})
	// 保留 Task 4 的行为：未知路径返回按语言翻译的 NOT_FOUND
	engine.NoRoute(func(c *gin.Context) {
		writeErr(c, apperr.New(http.StatusNotFound, apperr.CodeNotFound))
	})
	return engine
}
