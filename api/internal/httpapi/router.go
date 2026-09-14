// Package httpapi 装配 HTTP 路由：公共中间件、各模块 handler 与错误处理。
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// RouterDeps 是构建路由所需的依赖。后续任务会追加 Server、IAM、Env 字段。
type RouterDeps struct {
	Log     *slog.Logger
	Catalog *i18n.Catalog
	Pool    *pgxpool.Pool
}

type healthBody struct {
	Status string `json:"status"`
}

// trustedProxies：只信任本机与私有网段（compose 网络里的 Caddy）转发的 X-Forwarded-For，
// 这样 c.ClientIP() 才是真实客户端 IP，登录限流按人计算。以后在 Caddy 前面加 Cloudflare 时，由 Caddy 的 trusted_proxies 处理。
var trustedProxies = []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// NewRouter 创建 gin 引擎。Task 5 会把下面手写的健康检查路由换成 OpenAPI 生成的 strict handler。
func NewRouter(d RouterDeps) *gin.Engine {
	r := gin.New()
	if err := r.SetTrustedProxies(trustedProxies); err != nil {
		panic(err) // 列表是常量，出错说明代码写错了
	}
	r.Use(
		httpx.RequestID(),
		httpx.AccessLog(d.Log),
		httpx.Recover(d.Catalog, d.Log),
		httpx.Locale(),
	)

	api := r.Group("/api")
	api.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, healthBody{Status: "ok"})
	})
	api.GET("/readyz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c, 2*time.Second)
		defer cancel()
		if err := d.Pool.Ping(ctx); err != nil {
			d.Log.WarnContext(c, "readiness check failed", "error", err)
			c.JSON(http.StatusServiceUnavailable, healthBody{Status: "unavailable"})
			return
		}
		c.JSON(http.StatusOK, healthBody{Status: "ok"})
	})

	r.NoRoute(func(c *gin.Context) {
		httpx.WriteError(c, d.Catalog, d.Log, apperr.New(http.StatusNotFound, apperr.CodeNotFound))
	})
	return r
}
