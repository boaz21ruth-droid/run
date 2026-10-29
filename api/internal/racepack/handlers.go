package racepack

import (
	"context"
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

// Handlers 实现领物核销站与现场人员指派的接口。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建领物接口。
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

func (h *Handlers) AdminListRacepackEvents(ctx context.Context, _ apigen.AdminListRacepackEventsRequestObject) (apigen.AdminListRacepackEventsResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	events, err := h.svc.ListEvents(ctx, actor)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.RacepackEvent, 0, len(events))
	for _, e := range events {
		items = append(items, eventToAPI(e))
	}
	return apigen.AdminListRacepackEvents200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminGetRacepackStation(ctx context.Context, req apigen.AdminGetRacepackStationRequestObject) (apigen.AdminGetRacepackStationResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	query := ""
	if req.Params.Q != nil {
		query = *req.Params.Q
	}
	st, err := h.svc.Station(ctx, actor, req.Id, query)
	if err != nil {
		return nil, err
	}
	out := apigen.AdminGetRacepackStation200JSONResponse{
		Event:     eventToAPI(st.Event),
		Confirmed: st.Confirmed,
		Picked:    st.Picked,
		Recent:    make([]apigen.RacepackRecent, 0, len(st.Recent)),
		Results:   make([]apigen.RacepackEntry, 0, len(st.Results)),
	}
	for _, r := range st.Recent {
		out.Recent = append(out.Recent, apigen.RacepackRecent{
			RegistrationId: r.RegistrationID,
			FullName:       r.FullName,
			Bib:            r.Bib,
			ProxyName:      r.ProxyName,
			StaffName:      r.StaffName,
			OccurredAt:     r.OccurredAt,
		})
	}
	for _, e := range st.Results {
		out.Results = append(out.Results, entryToAPI(e))
	}
	return out, nil
}

func (h *Handlers) AdminIssueRacepack(ctx context.Context, req apigen.AdminIssueRacepackRequestObject) (apigen.AdminIssueRacepackResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in := IssueInput{
		ClientEventID: req.Body.ClientEventId,
		DeviceID:      req.Body.DeviceId,
		ProxyName:     req.Body.ProxyName,
		IDVerified:    req.Body.IdVerified != nil && *req.Body.IdVerified,
	}
	outcome, entry, err := h.svc.Issue(ctx, actor, req.Id, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminIssueRacepack200JSONResponse{
		Outcome: apigen.RacepackActionResultOutcome(outcome),
		Entry:   entryToAPI(entry),
	}, nil
}

func (h *Handlers) AdminUndoRacepack(ctx context.Context, req apigen.AdminUndoRacepackRequestObject) (apigen.AdminUndoRacepackResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	outcome, entry, err := h.svc.Undo(ctx, actor, req.Id, UndoInput{
		ClientEventID: req.Body.ClientEventId,
		DeviceID:      req.Body.DeviceId,
		Reason:        req.Body.Reason,
	}, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminUndoRacepack200JSONResponse{
		Outcome: apigen.RacepackActionResultOutcome(outcome),
		Entry:   entryToAPI(entry),
	}, nil
}

func (h *Handlers) AdminListStaff(ctx context.Context, _ apigen.AdminListStaffRequestObject) (apigen.AdminListStaffResponseObject, error) {
	members, err := h.svc.ListStaff(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.StaffMember, 0, len(members))
	for _, m := range members {
		items = append(items, apigen.StaffMember{
			Id: m.ID, Username: m.Username, FullName: m.FullName, Role: m.Role, Status: apigen.StaffMemberStatus(m.Status),
		})
	}
	return apigen.AdminListStaff200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminListEventAssignments(ctx context.Context, req apigen.AdminListEventAssignmentsRequestObject) (apigen.AdminListEventAssignmentsResponseObject, error) {
	list, err := h.svc.ListAssignments(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminListEventAssignments200JSONResponse{Items: assignmentsToAPI(list)}, nil
}

func (h *Handlers) AdminPutEventAssignment(ctx context.Context, req apigen.AdminPutEventAssignmentRequestObject) (apigen.AdminPutEventAssignmentResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	list, err := h.svc.PutAssignment(ctx, actor, req.Id, req.StaffId, req.Body.ValidFrom, req.Body.ValidUntil, req.Body.Enabled, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminPutEventAssignment200JSONResponse{Items: assignmentsToAPI(list)}, nil
}

func assignmentsToAPI(list []Assignment) []apigen.EventAssignment {
	out := make([]apigen.EventAssignment, 0, len(list))
	for _, a := range list {
		out = append(out, apigen.EventAssignment{
			StaffId: a.StaffID, Username: a.Username, FullName: a.FullName, Role: a.Role,
			ValidFrom: a.ValidFrom, ValidUntil: a.ValidUntil, Enabled: a.Enabled,
		})
	}
	return out
}

func eventToAPI(e Event) apigen.RacepackEvent {
	return apigen.RacepackEvent{
		Id:       e.ID,
		Name:     localizedToAPI(e.Name),
		City:     e.City,
		RaceDate: openapi_types.Date{Time: e.RaceDate},
		Timezone: e.Timezone,
	}
}

func entryToAPI(e Entry) apigen.RacepackEntry {
	out := apigen.RacepackEntry{
		RegistrationId: e.RegistrationID,
		RegNo:          e.RegNo,
		OrderNo:        e.OrderNo,
		Status:         apigen.RacepackEntryStatus(e.Status),
		OrderStatus:    e.OrderStatus,
		FullName:       e.FullName,
		TshirtSize:     e.TshirtSize,
		PhoneLast4:     e.PhoneLast4,
		Audience:       apigen.RacepackEntryAudience(e.Audience),
		CategoryCode:   e.CategoryCode,
		CategoryName:   localizedToAPI(e.CategoryName),
		Bib:            e.Bib,
		Picked:         e.Picked,
		PickedAt:       e.PickedAt,
		PickedByName:   e.PickedByName,
		ProxyName:      e.ProxyName,
		IdVerified:     e.IDVerified,
	}
	if e.BlockReason != nil {
		v := apigen.RacepackEntryBlockReason(*e.BlockReason)
		out.BlockReason = &v
	}
	return out
}

func localizedToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}
