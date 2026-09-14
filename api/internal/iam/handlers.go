package iam

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

// Handlers 实现 adminLogin / adminLogout / adminGetMe。
type Handlers struct {
	svc          *Service
	secureCookie bool
}

// NewHandlers：secureCookie 在 WERUN_ENV=prod 时为 true。
func NewHandlers(svc *Service, secureCookie bool) *Handlers {
	return &Handlers{svc: svc, secureCookie: secureCookie}
}

func (h *Handlers) AdminLogin(ctx context.Context, req apigen.AdminLoginRequestObject) (apigen.AdminLoginResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	token, staff, err := h.svc.Login(ctx, req.Body.Username, req.Body.Password, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	if c, ok := httpx.Gin(ctx); ok {
		h.setSessionCookie(c, token, int(AbsoluteTimeout.Seconds()))
	}
	return apigen.AdminLogin200JSONResponse(toMe(staff)), nil
}

func (h *Handlers) AdminLogout(ctx context.Context, _ apigen.AdminLogoutRequestObject) (apigen.AdminLogoutResponseObject, error) {
	if c, ok := httpx.Gin(ctx); ok {
		if token, err := c.Cookie(CookieName); err == nil && token != "" {
			if err := h.svc.Logout(ctx, token); err != nil {
				return nil, err
			}
		}
		h.setSessionCookie(c, "", -1)
	}
	return apigen.AdminLogout204Response{}, nil
}

func (h *Handlers) AdminGetMe(ctx context.Context, _ apigen.AdminGetMeRequestObject) (apigen.AdminGetMeResponseObject, error) {
	staff, ok := StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return apigen.AdminGetMe200JSONResponse(toMe(staff)), nil
}

func (h *Handlers) setSessionCookie(c *gin.Context, value string, maxAge int) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     CookiePath,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.secureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

func toMe(s Staff) apigen.Me {
	perms := make(map[string]apigen.Access)
	for p, a := range PermissionsOf(s.Role) {
		perms[string(p)] = apigen.Access(a)
	}
	return apigen.Me{
		Staff: apigen.Staff{
			Id:       s.ID,
			Username: s.Username,
			FullName: s.FullName,
			Role:     apigen.Role(s.Role),
		},
		Permissions: perms,
	}
}
