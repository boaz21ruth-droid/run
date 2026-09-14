package httpx

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// ErrorBody 是所有错误响应的 JSON 结构。
type ErrorBody struct {
	Error ErrorPayload `json:"error"`
}

// ErrorPayload 是错误详情。Message 与 Fields 的值均已按请求语言本地化。
type ErrorPayload struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

// WriteError 把错误写成 JSON 响应并中止请求。
// *apperr.Error 使用自身的状态码与文案；其它错误一律返回 500 INTERNAL，
// 原始错误只写日志，不暴露给前端。
func WriteError(c *gin.Context, cat *i18n.Catalog, log *slog.Logger, err error) {
	ae, ok := apperr.As(err)
	switch {
	case !ok:
		log.ErrorContext(c, "unhandled error",
			"error", err, "request_id", RequestIDOf(c), "path", c.Request.URL.Path)
		ae = apperr.New(http.StatusInternalServerError, apperr.CodeInternal)
	case ae.Status >= http.StatusInternalServerError:
		log.ErrorContext(c, "server error",
			"error", err, "code", ae.Code, "request_id", RequestIDOf(c), "path", c.Request.URL.Path)
	}

	lang := LangOf(c)
	body := ErrorBody{Error: ErrorPayload{
		Code:    ae.Code,
		Message: cat.T(lang, ae.Code, ae.Params),
	}}
	if len(ae.Fields) > 0 {
		body.Error.Fields = make(map[string]string, len(ae.Fields))
		for field, fe := range ae.Fields {
			body.Error.Fields[field] = cat.T(lang, fe.Key, fe.Params)
		}
	}
	c.AbortWithStatusJSON(ae.Status, body)
}
