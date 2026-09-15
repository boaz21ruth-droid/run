package registration

import (
	"context"
	"net/http"

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
