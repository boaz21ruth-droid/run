package runner

import (
	"context"
	"net/http"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
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

// AppRequestPhoneCode 向手机号发送登录验证码。
func (h *Handlers) AppRequestPhoneCode(ctx context.Context, req apigen.AppRequestPhoneCodeRequestObject) (apigen.AppRequestPhoneCodeResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	res, err := h.svc.RequestPhoneCode(ctx, strings.TrimSpace(req.Body.Phone), httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppRequestPhoneCode200JSONResponse{
		ExpiresInSeconds:   int(res.ExpiresIn / time.Second),
		ResendAfterSeconds: int(res.ResendAfter / time.Second),
		Channel:            apigen.PhoneCodeSentChannel(res.Channel),
	}, nil
}

// AppVerifyPhoneCode 校验验证码并签发跑者令牌。
func (h *Handlers) AppVerifyPhoneCode(ctx context.Context, req apigen.AppVerifyPhoneCodeRequestObject) (apigen.AppVerifyPhoneCodeResponseObject, error) {
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	sess, err := h.svc.VerifyPhoneCode(ctx, strings.TrimSpace(req.Body.Phone), strings.TrimSpace(req.Body.Code), string(httpx.LangOf(ctx)), httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppVerifyPhoneCode200JSONResponse{Token: sess.Token, ExpiresAt: sess.ExpiresAt, User: toAppUser(sess.User)}, nil
}

// AppUpdateMe 修改显示名或语言。
func (h *Handlers) AppUpdateMe(ctx context.Context, req apigen.AppUpdateMeRequestObject) (apigen.AppUpdateMeResponseObject, error) {
	u, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	var locale *string
	if req.Body.Locale != nil {
		l := string(*req.Body.Locale)
		locale = &l
	}
	updated, err := h.svc.UpdateMe(ctx, u.ID, req.Body.DisplayName, locale, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppUpdateMe200JSONResponse(toAppUser(updated)), nil
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
	out := apigen.AppUser{Id: u.ID, DisplayName: u.DisplayName, Locale: apigen.AppUserLocale(u.Locale)}
	if u.TelegramUserID != 0 {
		id := u.TelegramUserID
		out.TelegramUserId = &id
		name := u.TelegramUsername
		out.TelegramUsername = &name
	}
	if u.Phone != "" {
		m := maskPhone(u.Phone)
		out.PhoneMasked = &m
	}
	return out
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

func (h *Handlers) AppGetConsent(ctx context.Context, req apigen.AppGetConsentRequestObject) (apigen.AppGetConsentResponseObject, error) {
	if string(req.Params.Purpose) != PurposeRegistration {
		return nil, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("purpose", "field.invalid", nil)
	}
	lang := httpx.LangOf(ctx)
	if req.Params.Lang != nil {
		if l, ok := i18n.Parse(string(*req.Params.Lang)); ok {
			lang = l
		}
	}
	v, err := h.svc.CurrentConsent(ctx, PurposeRegistration, lang)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.ConsentItem, 0, len(v.Items))
	for _, item := range v.Items {
		items = append(items, apigen.ConsentItem{Key: item.Key, Title: item.Title, Description: item.Description})
	}
	return apigen.AppGetConsent200JSONResponse{
		Version:       v.Version,
		Lang:          v.Lang,
		EffectiveDate: openapi_types.Date{Time: v.EffectiveDate},
		FullText:      v.FullText,
		Items:         items,
	}, nil
}
