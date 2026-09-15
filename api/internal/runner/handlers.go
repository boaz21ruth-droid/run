package runner

import (
	"context"
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

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

func (h *Handlers) AppListProfiles(ctx context.Context, _ apigen.AppListProfilesRequestObject) (apigen.AppListProfilesResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	profiles, err := h.svc.ListProfiles(ctx, u)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.RunnerProfile, 0, len(profiles))
	for _, p := range profiles {
		items = append(items, toRunnerProfile(p))
	}
	return apigen.AppListProfiles200JSONResponse{Items: items}, nil
}

func (h *Handlers) AppCreateProfile(ctx context.Context, req apigen.AppCreateProfileRequestObject) (apigen.AppCreateProfileResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	data, isSelf := profileInputFromAPI(*req.Body)
	p, err := h.svc.CreateProfile(ctx, u, data, isSelf)
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateProfile201JSONResponse(toRunnerProfile(p)), nil
}

func (h *Handlers) AppUpdateProfile(ctx context.Context, req apigen.AppUpdateProfileRequestObject) (apigen.AppUpdateProfileResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	data, isSelf := profileInputFromAPI(*req.Body)
	p, err := h.svc.UpdateProfile(ctx, u, req.Id, data, isSelf)
	if err != nil {
		return nil, err
	}
	return apigen.AppUpdateProfile200JSONResponse(toRunnerProfile(p)), nil
}

func (h *Handlers) AppDeleteProfile(ctx context.Context, req apigen.AppDeleteProfileRequestObject) (apigen.AppDeleteProfileResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.DeleteProfile(ctx, u, req.Id); err != nil {
		return nil, err
	}
	return apigen.AppDeleteProfile204Response{}, nil
}

func profileInputFromAPI(b apigen.ProfileInput) (ProfileData, bool) {
	data := ProfileData{
		FullName:       b.FullName,
		Gender:         string(b.Gender),
		BirthDate:      b.BirthDate.Time,
		Nationality:    b.Nationality,
		IDType:         string(b.IdType),
		IDNo:           derefString(b.IdNo),
		Phone:          b.Phone,
		Email:          derefString(b.Email),
		EmergencyName:  b.EmergencyName,
		EmergencyPhone: b.EmergencyPhone,
		TShirtSize:     string(b.TshirtSize),
	}
	return data, b.IsSelf != nil && *b.IsSelf
}

// toRunnerProfile 只输出掩码后的证件号。
func toRunnerProfile(p Profile) apigen.RunnerProfile {
	return apigen.RunnerProfile{
		Id:             p.ID,
		FullName:       p.Data.FullName,
		Gender:         apigen.Gender(p.Data.Gender),
		BirthDate:      openapi_types.Date{Time: p.Data.BirthDate},
		Nationality:    p.Data.Nationality,
		IdType:         apigen.IdType(p.Data.IDType),
		IdNoMasked:     p.IDNoMasked,
		Phone:          p.Data.Phone,
		Email:          p.Data.Email,
		EmergencyName:  p.Data.EmergencyName,
		EmergencyPhone: p.Data.EmergencyPhone,
		TshirtSize:     apigen.TShirtSize(p.Data.TShirtSize),
		IsSelf:         p.IsSelf,
	}
}
