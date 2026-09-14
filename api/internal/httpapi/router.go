package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// RouterDeps 是构造 HTTP 路由所需的依赖。
type RouterDeps struct {
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
	Server  *Server // 为 nil 时由 NewServer 构造
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
		httpx.RequestID(),
		httpx.AccessLog(d.Log),
		httpx.Recover(d.Catalog, d.Log),
		httpx.Locale(),
	)

	server := d.Server
	if server == nil {
		server = NewServer(d)
	}

	writeErr := func(c *gin.Context, err error) {
		httpx.WriteError(c, d.Catalog, d.Log, err)
	}
	strict := apigen.NewStrictHandlerWithOptions(server, nil, apigen.StrictGinServerOptions{
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
