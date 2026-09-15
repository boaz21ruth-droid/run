package event

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
)

// Handlers 实现 apigen.StrictServerInterface 中的赛事相关操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建赛事 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) ListPublicEvents(ctx context.Context, _ apigen.ListPublicEventsRequestObject) (apigen.ListPublicEventsResponseObject, error) {
	events, err := h.svc.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	lang := httpx.LangOf(ctx)
	items := make([]apigen.PublicEvent, 0, len(events))
	for _, e := range events {
		items = append(items, toPublicEvent(e, lang))
	}
	return apigen.ListPublicEvents200JSONResponse{Items: items}, nil
}

func (h *Handlers) GetPublicEvent(ctx context.Context, req apigen.GetPublicEventRequestObject) (apigen.GetPublicEventResponseObject, error) {
	ev, err := h.svc.GetPublic(ctx, req.Slug)
	if err != nil {
		return nil, err
	}
	return apigen.GetPublicEvent200JSONResponse(toPublicEvent(ev, httpx.LangOf(ctx))), nil
}

func (h *Handlers) AdminListEvents(ctx context.Context, _ apigen.AdminListEventsRequestObject) (apigen.AdminListEventsResponseObject, error) {
	events, err := h.svc.ListAll(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.AdminEvent, 0, len(events))
	for _, e := range events {
		items = append(items, toAdminEvent(e))
	}
	return apigen.AdminListEvents200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreateEvent(ctx context.Context, req apigen.AdminCreateEventRequestObject) (apigen.AdminCreateEventResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	ev, err := h.svc.Create(ctx, actor, createInputFromAPI(*req.Body))
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreateEvent201JSONResponse(toAdminEvent(ev)), nil
}

func (h *Handlers) AdminPublishEvent(ctx context.Context, req apigen.AdminPublishEventRequestObject) (apigen.AdminPublishEventResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	ev, err := h.svc.Publish(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminPublishEvent200JSONResponse(toAdminEvent(ev)), nil
}

func (h *Handlers) AdminGetEvent(ctx context.Context, req apigen.AdminGetEventRequestObject) (apigen.AdminGetEventResponseObject, error) {
	ev, err := h.svc.GetAdmin(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetEvent200JSONResponse(toAdminEvent(ev)), nil
}

func (h *Handlers) AdminUpdateEventRegistration(ctx context.Context, req apigen.AdminUpdateEventRegistrationRequestObject) (apigen.AdminUpdateEventRegistrationResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	ev, err := h.svc.UpdateRegistration(ctx, actor, req.Id, RegistrationInput{
		Open:     req.Body.Open,
		OpensAt:  req.Body.OpensAt,
		ClosesAt: req.Body.ClosesAt,
	})
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateEventRegistration200JSONResponse(toAdminEvent(ev)), nil
}

func toPublicEvent(e Event, lang i18n.Lang) apigen.PublicEvent {
	cats := make([]apigen.PublicCategory, 0, len(e.Categories))
	for _, c := range e.Categories {
		cats = append(cats, apigen.PublicCategory{
			Id:        c.ID,
			Code:      c.Code,
			Name:      c.Name.In(lang),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   derefTime(c.StartAt),
			CutoffAt:  derefTime(c.CutoffAt),
			MinAge:    int32(c.MinAge),
			SoldOut:   int64(c.UsedCount)+int64(c.ReservedCount) >= int64(c.Capacity),
		})
	}
	return apigen.PublicEvent{
		Id:                   e.ID,
		Slug:                 e.Slug,
		EventType:            apigen.PublicEventEventType(e.EventType),
		Name:                 e.Name.In(lang),
		City:                 e.City,
		RaceDate:             openapi_types.Date{Time: e.RaceDate},
		RegistrationOpen:     e.RegistrationOpen,
		RegistrationOpensAt:  e.RegistrationOpensAt,
		RegistrationClosesAt: e.RegistrationClosesAt,
		Categories:           cats,
	}
}

func toAdminEvent(e Event) apigen.AdminEvent {
	cats := make([]apigen.AdminCategory, 0, len(e.Categories))
	for _, c := range e.Categories {
		cats = append(cats, apigen.AdminCategory{
			Id:        c.ID,
			Code:      c.Code,
			Name:      textToAPI(c.Name),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   c.StartAt,
			CutoffAt:  c.CutoffAt,
		})
	}
	return apigen.AdminEvent{
		Id:                   e.ID,
		Slug:                 e.Slug,
		EventType:            apigen.AdminEventEventType(e.EventType),
		OrganizerType:        apigen.AdminEventOrganizerType(e.OrganizerType),
		Name:                 textToAPI(e.Name),
		City:                 e.City,
		RaceDate:             openapi_types.Date{Time: e.RaceDate},
		Timezone:             e.Timezone,
		Status:               apigen.AdminEventStatus(e.Status),
		PublicVisible:        e.PublicVisible,
		PublishedAt:          e.PublishedAt,
		RegistrationOpen:     e.RegistrationOpen,
		RegistrationOpensAt:  e.RegistrationOpensAt,
		RegistrationClosesAt: e.RegistrationClosesAt,
		Categories:           cats,
	}
}

func createInputFromAPI(b apigen.CreateEventRequest) CreateInput {
	cats := make([]CategoryInput, 0, len(b.Categories))
	for _, c := range b.Categories {
		cats = append(cats, CategoryInput{
			Code:      c.Code,
			Name:      textFromAPI(c.Name),
			DistanceM: c.DistanceM,
			Capacity:  c.Capacity,
			StartAt:   c.StartAt,
			CutoffAt:  c.CutoffAt,
		})
	}
	return CreateInput{
		Slug:          b.Slug,
		EventType:     string(b.EventType),
		OrganizerType: string(b.OrganizerType),
		Name:          textFromAPI(b.Name),
		City:          b.City,
		RaceDate:      b.RaceDate.Time,
		Categories:    cats,
	}
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
	if l.Zh != nil {
		t[i18n.ZH] = *l.Zh
	}
	if l.En != nil {
		t[i18n.EN] = *l.En
	}
	if l.Km != nil {
		t[i18n.KM] = *l.Km
	}
	return t
}

func derefTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}
