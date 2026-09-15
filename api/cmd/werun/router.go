package main

import (
	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi"
)

// newRouter 装配 HTTP 路由。serve 命令与测试共用这一处装配逻辑。
func newRouter(app *App) *gin.Engine {
	return httpapi.NewRouter(httpapi.RouterDeps{
		Log:          app.Log,
		Catalog:      app.Catalog,
		Pool:         app.Pool,
		IAM:          app.IAM,
		Runner:       app.Runner,
		Events:       app.Events,
		Pricing:      app.Pricing,
		Registration: app.Registration,
		Payment:      app.Payment,
		Notify:       app.Notify,
		Env:          app.Cfg.Env,
	})
}
