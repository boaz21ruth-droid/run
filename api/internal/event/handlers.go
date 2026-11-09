package event

import (
	"context"
	"fmt"
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
			Id:            c.ID,
			Code:          c.Code,
			Name:          c.Name.In(lang),
			DistanceM:     c.DistanceM,
			Capacity:      c.Capacity,
			StartAt:       derefTime(c.StartAt),
			CutoffAt:      derefTime(c.CutoffAt),
			MinAge:        int32(c.MinAge),
			SoldOut:       int64(c.UsedCount)+int64(c.ReservedCount) >= int64(c.Capacity),
			Remaining:     remainingOf(c),
			Qualification: publicQualificationOf(c.Qualification, lang),
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
		FromPriceCents:       e.FromPriceCents,
		CoverUrl:             coverURLOf(e.CoverFileID),
		PriceTiers:           toPublicPriceTiers(e.PriceTiers, lang),
		RegisteredCount:      registeredOf(e.Categories),
		CompOpen:             e.CompOpen,
		RefundPolicy:         refundPolicyToAPI(e.RefundPolicy),
	}
}

func publicQualificationOf(q *Qualification, lang i18n.Lang) *apigen.PublicQualification {
	if q == nil {
		return nil
	}
	return &apigen.PublicQualification{Rule: q.Rule.In(lang), MaxTimeMs: q.MaxMs, FallbackCategoryId: q.FallbackCategoryID}
}

func adminQualificationOf(q *Qualification) *apigen.AdminQualification {
	if q == nil {
		return nil
	}
	return &apigen.AdminQualification{Rule: textToAPI(q.Rule), MaxTimeMs: q.MaxMs, FallbackCategoryId: q.FallbackCategoryID}
}

func refundPolicyToAPI(p *RefundPolicy) *apigen.RefundPolicy {
	if p == nil {
		return nil
	}
	tiers := make([]apigen.RefundTier, 0, len(p.Tiers))
	for _, t := range p.Tiers {
		tiers = append(tiers, apigen.RefundTier{Days: t.Days, Percent: t.Percent})
	}
	return &apigen.RefundPolicy{Tiers: tiers, TransferDays: p.TransferDays}
}

func refundPolicyFromAPI(p *apigen.RefundPolicy) *RefundPolicy {
	if p == nil {
		return nil
	}
	tiers := make([]RefundTier, 0, len(p.Tiers))
	for _, t := range p.Tiers {
		tiers = append(tiers, RefundTier{Days: t.Days, Percent: t.Percent})
	}
	return &RefundPolicy{Tiers: tiers, TransferDays: p.TransferDays}
}

func toPublicPriceTiers(tiers []PriceTier, lang i18n.Lang) []apigen.PublicPriceTier {
	out := make([]apigen.PublicPriceTier, 0, len(tiers))
	for _, t := range tiers {
		out = append(out, apigen.PublicPriceTier{
			Id:           t.ID,
			Name:         t.Name.In(lang),
			Audience:     apigen.PublicPriceTierAudience(t.Audience),
			PriceCents:   t.PriceCents,
			Currency:     t.Currency,
			Quota:        t.Quota,
			Remaining:    t.Remaining,
			SaleStartsAt: t.SaleStartsAt,
			SaleEndsAt:   t.SaleEndsAt,
			State:        apigen.PublicPriceTierState(t.State),
		})
	}
	return out
}

// registeredOf 返回已确认报名人数：各组别 used_count 之和（待付款占用的 reserved_count 不计）。
func registeredOf(cats []Category) int32 {
	var n int32
	for _, c := range cats {
		n += c.UsedCount
	}
	return n
}

// remainingOf 返回组别剩余名额：capacity - used_count - reserved_count，下限为 0。
func remainingOf(c Category) int32 {
	remaining := c.Capacity - c.UsedCount - c.ReservedCount
	if remaining < 0 {
		return 0
	}
	return remaining
}

// coverURLOf 返回封面图的公开访问地址（沿用 OrderPaymentAccount.QrFileId 注释里
// /api/files/{id} 的约定）；未设置封面时返回 nil。
func coverURLOf(fileID *int64) *string {
	if fileID == nil {
		return nil
	}
	url := fmt.Sprintf("/api/files/%d", *fileID)
	return &url
}

func toAdminEvent(e Event) apigen.AdminEvent {
	cats := make([]apigen.AdminCategory, 0, len(e.Categories))
	for _, c := range e.Categories {
		cats = append(cats, apigen.AdminCategory{
			Id:            c.ID,
			Code:          c.Code,
			Name:          textToAPI(c.Name),
			DistanceM:     c.DistanceM,
			Capacity:      c.Capacity,
			StartAt:       c.StartAt,
			CutoffAt:      c.CutoffAt,
			Qualification: adminQualificationOf(c.Qualification),
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
		RefundPolicy:         refundPolicyToAPI(e.RefundPolicy),
	}
}

func (h *Handlers) AdminUpdateRefundPolicy(ctx context.Context, req apigen.AdminUpdateRefundPolicyRequestObject) (apigen.AdminUpdateRefundPolicyResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	ev, err := h.svc.UpdateRefundPolicy(ctx, actor, req.Id, refundPolicyFromAPI(req.Body.Policy))
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateRefundPolicy200JSONResponse(toAdminEvent(ev)), nil
}

func (h *Handlers) AdminUpdateCategoryQualification(ctx context.Context, req apigen.AdminUpdateCategoryQualificationRequestObject) (apigen.AdminUpdateCategoryQualificationResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	var qual *Qualification
	if q := req.Body.Qualification; q != nil {
		qual = &Qualification{Rule: textFromAPI(q.Rule), MaxMs: q.MaxTimeMs, FallbackCategoryID: q.FallbackCategoryId}
	}
	ev, err := h.svc.UpdateQualification(ctx, actor, req.Id, qual)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateCategoryQualification200JSONResponse(toAdminEvent(ev)), nil
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
