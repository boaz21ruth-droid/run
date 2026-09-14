package main

import (
	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi"
)

// newRouter 装配 HTTP 路由。serve 命令与测试共用这一处装配逻辑。
// httpapi.NewRouter 在 RouterDeps.Server 为 nil 时自己调用 NewServer 构造全部 handler。
func newRouter(app *App) *gin.Engine {
	return httpapi.NewRouter(httpapi.RouterDeps{
		Log:     app.Log,
		Catalog: app.Catalog,
		Pool:    app.Pool,
		IAM:     app.IAM,
		Env:     app.Cfg.Env,
	})
}
