package volunteer

import (
	"context"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner"
)

// Handlers 实现志愿者接口。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建接口。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func actorOf(ctx context.Context) (iam.Staff, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return iam.Staff{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return actor, nil
}

func runnerOf(ctx context.Context) (runner.User, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return runner.User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

func badRequest() error { return apperr.New(http.StatusBadRequest, apperr.CodeBadRequest) }

func (h *Handlers) AppGetVolunteer(ctx context.Context, req apigen.AppGetVolunteerRequestObject) (apigen.AppGetVolunteerResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	v, err := h.svc.GetForRunner(ctx, u, req.Slug)
	if err != nil {
		return nil, err
	}
	lang := httpx.LangOf(ctx)
	roles := make([]apigen.PublicVolunteerRole, 0, len(v.Roles))
	for _, r := range v.Roles {
		roles = append(roles, apigen.PublicVolunteerRole{
			Id: r.ID, Name: r.Name.In(lang), Schedule: optIn(r.Schedule, lang), Capacity: r.Capacity, Remaining: r.Remaining(),
		})
	}
	out := apigen.AppGetVolunteer200JSONResponse{
		Open: v.Settings.Open, Dates: datesToAPI(v.Settings.Dates), Note: optIn(v.Settings.Note, lang), Roles: roles,
	}
	if v.Application != nil {
		app := applicationToAPI(*v.Application, lang)
		out.Application = &app
	}
	return out, nil
}

func (h *Handlers) AppApplyVolunteer(ctx context.Context, req apigen.AppApplyVolunteerRequestObject) (apigen.AppApplyVolunteerResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b := req.Body
	in := ApplyInput{
		FullName: b.FullName, Phone: b.Phone, FullAvailability: b.FullAvailability, RoleIDs: b.RoleIds,
		ConductAccepted: b.ConductAccepted,
	}
	if b.Dates != nil {
		in.Dates = datesFromAPI(*b.Dates)
	}
	if b.TshirtSize != nil {
		in.TShirtSize = string(*b.TshirtSize)
	}
	if b.Note != nil {
		in.Note = *b.Note
	}
	if b.MediaConsent != nil {
		in.MediaConsent = *b.MediaConsent
	}
	app, err := h.svc.Apply(ctx, u, req.Slug, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppApplyVolunteer201JSONResponse(applicationToAPI(app, httpx.LangOf(ctx))), nil
}

func (h *Handlers) AppWithdrawVolunteer(ctx context.Context, req apigen.AppWithdrawVolunteerRequestObject) (apigen.AppWithdrawVolunteerResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	app, err := h.svc.Withdraw(ctx, u, req.Slug, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppWithdrawVolunteer200JSONResponse(applicationToAPI(app, httpx.LangOf(ctx))), nil
}

func (h *Handlers) AdminGetVolunteers(ctx context.Context, req apigen.AdminGetVolunteersRequestObject) (apigen.AdminGetVolunteersResponseObject, error) {
	b, err := h.svc.Board(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetVolunteers200JSONResponse(boardToAPI(b)), nil
}

func (h *Handlers) AdminUpdateVolunteerSettings(ctx context.Context, req apigen.AdminUpdateVolunteerSettingsRequestObject) (apigen.AdminUpdateVolunteerSettingsResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	in := Settings{Open: req.Body.Open, Dates: datesFromAPI(req.Body.Dates)}
	if req.Body.Note != nil {
		in.Note = textFromAPI(*req.Body.Note)
	}
	b, err := h.svc.UpdateSettings(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateVolunteerSettings200JSONResponse(boardToAPI(b)), nil
}

func (h *Handlers) AdminCreateVolunteerRole(ctx context.Context, req apigen.AdminCreateVolunteerRoleRequestObject) (apigen.AdminCreateVolunteerRoleResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b := req.Body
	b2, err := h.svc.CreateRole(ctx, actor, req.Id, roleInput(b.Name, b.Schedule, b.Capacity, b.SortOrder, true))
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreateVolunteerRole201JSONResponse(boardToAPI(b2)), nil
}

func (h *Handlers) AdminUpdateVolunteerRole(ctx context.Context, req apigen.AdminUpdateVolunteerRoleRequestObject) (apigen.AdminUpdateVolunteerRoleResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b := req.Body
	board, err := h.svc.UpdateRole(ctx, actor, req.Id, roleInput(b.Name, b.Schedule, b.Capacity, b.SortOrder, b.Active))
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateVolunteerRole200JSONResponse(boardToAPI(board)), nil
}

func (h *Handlers) AdminAssignVolunteer(ctx context.Context, req apigen.AdminAssignVolunteerRequestObject) (apigen.AdminAssignVolunteerResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b, err := h.svc.Assign(ctx, actor, req.Id, req.Body.RoleId)
	if err != nil {
		return nil, err
	}
	return apigen.AdminAssignVolunteer200JSONResponse(boardToAPI(b)), nil
}

func (h *Handlers) AdminWaitlistVolunteer(ctx context.Context, req apigen.AdminWaitlistVolunteerRequestObject) (apigen.AdminWaitlistVolunteerResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	b, err := h.svc.Waitlist(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminWaitlistVolunteer200JSONResponse(boardToAPI(b)), nil
}

func (h *Handlers) AdminRejectVolunteer(ctx context.Context, req apigen.AdminRejectVolunteerRequestObject) (apigen.AdminRejectVolunteerResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	var note string
	if req.Body != nil && req.Body.Note != nil {
		note = *req.Body.Note
	}
	b, err := h.svc.Reject(ctx, actor, req.Id, note)
	if err != nil {
		return nil, err
	}
	return apigen.AdminRejectVolunteer200JSONResponse(boardToAPI(b)), nil
}

func roleInput(name apigen.LocalizedText, schedule *apigen.LocalizedText, capacity int32, sortOrder *int32, active bool) RoleInput {
	in := RoleInput{Name: textFromAPI(name), Capacity: capacity, Active: active}
	if schedule != nil {
		in.Schedule = textFromAPI(*schedule)
	}
	if sortOrder != nil {
		in.SortOrder = int16(min(max(*sortOrder, -32768), 32767))
	}
	return in
}

func boardToAPI(b Board) apigen.VolunteerBoard {
	roles := make([]apigen.AdminVolunteerRole, 0, len(b.Roles))
	for _, r := range b.Roles {
		var schedule *apigen.LocalizedText
		if len(r.Schedule) > 0 {
			s := textToAPI(r.Schedule)
			schedule = &s
		}
		roles = append(roles, apigen.AdminVolunteerRole{
			Id: r.ID, Name: textToAPI(r.Name), Schedule: schedule, Capacity: r.Capacity, AssignedCount: r.AssignedCount,
			SortOrder: int32(r.SortOrder), Active: r.Active, Candidates: r.Candidates,
		})
	}
	apps := make([]apigen.AdminVolunteerApplication, 0, len(b.Applications))
	for _, a := range b.Applications {
		apps = append(apps, apigen.AdminVolunteerApplication{
			Id: a.ID, Status: apigen.VolunteerStatus(a.Status), FullName: a.FullName, Phone: a.Phone,
			TelegramUsername: a.TelegramUsername, FullAvailability: a.FullAvailability, Dates: datesToAPI(a.Dates),
			RoleIds: a.RoleIDs, TshirtSize: a.TShirtSize, Note: a.Note, MediaConsent: a.MediaConsent,
			AssignedRoleId: a.AssignedRoleID, ReviewNote: a.ReviewNote, CreatedAt: a.CreatedAt,
		})
	}
	var note *apigen.LocalizedText
	if len(b.Settings.Note) > 0 {
		n := textToAPI(b.Settings.Note)
		note = &n
	}
	return apigen.VolunteerBoard{
		Settings:     apigen.VolunteerSettings{Open: b.Settings.Open, Dates: datesToAPI(b.Settings.Dates), Note: note},
		Roles:        roles,
		Applications: apps,
	}
}

func applicationToAPI(a Application, lang i18n.Lang) apigen.VolunteerApplication {
	return apigen.VolunteerApplication{
		Id: a.ID, Status: apigen.VolunteerStatus(a.Status), FullAvailability: a.FullAvailability, Dates: datesToAPI(a.Dates),
		RoleIds: a.RoleIDs, AssignedRoleName: optIn(a.AssignedRoleName, lang), ReviewNote: a.ReviewNote, CreatedAt: a.CreatedAt,
	}
}

func optIn(t i18n.Text, lang i18n.Lang) *string {
	if len(t) == 0 {
		return nil
	}
	v := t.In(lang)
	if v == "" {
		return nil
	}
	return &v
}

func datesToAPI(in []time.Time) []openapi_types.Date {
	out := make([]openapi_types.Date, 0, len(in))
	for _, d := range in {
		out = append(out, openapi_types.Date{Time: d})
	}
	return out
}

func datesFromAPI(in []openapi_types.Date) []time.Time {
	out := make([]time.Time, 0, len(in))
	for _, d := range in {
		out = append(out, d.Time)
	}
	return out
}

func textToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}

func textFromAPI(l apigen.LocalizedText) i18n.Text {
	t := i18n.Text{}
	for lang, v := range map[i18n.Lang]*string{i18n.ZH: l.Zh, i18n.EN: l.En, i18n.KM: l.Km} {
		if v != nil {
			t[lang] = *v
		}
	}
	return t
}
