package runner

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

// Handlers 实现 apigen.StrictServerInterface 中的跑者接口。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建跑者 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AppLoginTelegram(ctx context.Context, req apigen.AppLoginTelegramRequestObject) (apigen.AppLoginTelegramResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	sess, err := h.svc.LoginTelegram(ctx, req.Body.InitData, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppLoginTelegram200JSONResponse{
		Token:     sess.Token,
		ExpiresAt: sess.ExpiresAt,
		User:      toAppUser(sess.User),
	}, nil
}

func (h *Handlers) AppLogout(ctx context.Context, _ apigen.AppLogoutRequestObject) (apigen.AppLogoutResponseObject, error) {
	if c, ok := httpx.Gin(ctx); ok {
		if token := BearerToken(c.Request); token != "" {
			if err := h.svc.Logout(ctx, token); err != nil {
				return nil, err
			}
		}
	}
	return apigen.AppLogout204Response{}, nil
}

func (h *Handlers) AppGetMe(ctx context.Context, _ apigen.AppGetMeRequestObject) (apigen.AppGetMeResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	return apigen.AppGetMe200JSONResponse(toAppUser(u)), nil
}

// currentUser 取认证中间件放入的跑者；取不到说明接口没有声明 x-auth: app。
func currentUser(ctx context.Context) (User, error) {
	u, ok := UserFrom(ctx)
	if !ok {
		return User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

func toAppUser(u User) apigen.AppUser {
	return apigen.AppUser{
		Id:               u.ID,
		TelegramUserId:   u.TelegramUserID,
		TelegramUsername: u.TelegramUsername,
		DisplayName:      u.DisplayName,
		Locale:           apigen.AppUserLocale(u.Locale),
	}
}
