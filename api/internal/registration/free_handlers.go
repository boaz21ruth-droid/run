package registration

import (
	"context"
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/runner"
)

// AppCreateFreeSignup 免费活动报名。
func (h *Handlers) AppCreateFreeSignup(ctx context.Context, req apigen.AppCreateFreeSignupRequestObject) (apigen.AppCreateFreeSignupResponseObject, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	b := *req.Body
	in := FreeSignupInput{
		CategoryID:     b.CategoryId,
		FullName:       b.FullName,
		Phone:          b.Phone,
		EmergencyName:  b.EmergencyName,
		EmergencyPhone: b.EmergencyPhone,
		Consent: runner.ConsentAcceptance{
			Version:      b.Consents.Version,
			Lang:         string(b.Consents.Lang),
			CheckedItems: b.Consents.CheckedItems,
		},
	}
	if b.Gender != nil {
		g := string(*b.Gender)
		in.Gender = &g
	}
	if b.BirthDate != nil {
		d := b.BirthDate.Time
		in.BirthDate = &d
	}

	fs, err := h.svc.CreateFreeSignup(ctx, u, req.Slug, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateFreeSignup201JSONResponse{
		Id:         fs.ID,
		SignupNo:   fs.SignupNo,
		EventSlug:  fs.EventSlug,
		CategoryId: fs.CategoryID,
		FullName:   fs.FullName,
		Status:     fs.Status,
		CreatedAt:  fs.CreatedAt,
	}, nil
}

// AppListFreeSignups 我的免费报名。
func (h *Handlers) AppListFreeSignups(ctx context.Context, _ apigen.AppListFreeSignupsRequestObject) (apigen.AppListFreeSignupsResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	signups, err := h.svc.ListMyFreeSignups(ctx, u)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.FreeSignupSummary, 0, len(signups))
	for _, fs := range signups {
		items = append(items, apigen.FreeSignupSummary{
			SignupNo:     fs.SignupNo,
			EventSlug:    fs.EventSlug,
			EventName:    localizedToAPI(fs.EventName),
			RaceDate:     openapi_types.Date{Time: fs.RaceDate},
			CategoryName: localizedToAPI(fs.CategoryName),
			FullName:     fs.FullName,
			Status:       apigen.FreeSignupSummaryStatus(fs.Status),
			CreatedAt:    fs.CreatedAt,
		})
	}
	return apigen.AppListFreeSignups200JSONResponse{Items: items}, nil
}
