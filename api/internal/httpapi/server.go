package httpapi

import (
	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
)

// 各模块的 handler 类型都叫 Handlers，直接嵌入会出现同名字段；
// 用别名嵌入，字段名即别名（IAMHandlers、EventHandlers……）。
type IAMHandlers = iam.Handlers

// Server 组合各模块的 handler，实现 apigen.StrictServerInterface。
// 新增模块时在这里嵌入该模块的 handler，并在 NewServer 中构造。
type Server struct {
	*HealthHandlers
	*IAMHandlers
}

var _ apigen.StrictServerInterface = (*Server)(nil)

// NewServer 用路由依赖构造全部模块 handler。
func NewServer(d RouterDeps) *Server {
	return &Server{
		HealthHandlers: NewHealthHandlers(d.Pool),
		IAMHandlers:    iam.NewHandlers(d.IAM, d.Env == "prod"),
	}
}
