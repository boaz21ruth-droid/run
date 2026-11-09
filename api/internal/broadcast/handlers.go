package broadcast

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/runner"
)

// Handlers 实现群发通知接口。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建接口。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AdminGetBroadcasts(ctx context.Context, req apigen.AdminGetBroadcastsRequestObject) (apigen.AdminGetBroadcastsResponseObject, error) {
	b, err := h.svc.Board(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetBroadcasts200JSONResponse(boardToAPI(b)), nil
}

func (h *Handlers) AdminSendBroadcast(ctx context.Context, req apigen.AdminSendBroadcastRequestObject) (apigen.AdminSendBroadcastResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	b, err := h.svc.Send(ctx, actor, req.Id, string(req.Body.Audience), req.Body.Body)
	if err != nil {
		return nil, err
	}
	return apigen.AdminSendBroadcast201JSONResponse(boardToAPI(b)), nil
}

func (h *Handlers) AppListNotices(ctx context.Context, _ apigen.AppListNoticesRequestObject) (apigen.AppListNoticesResponseObject, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	items, err := h.svc.Notices(ctx, u)
	if err != nil {
		return nil, err
	}
	lang := httpx.LangOf(ctx)
	out := make([]apigen.Notice, 0, len(items))
	for _, n := range items {
		out = append(out, apigen.Notice{Id: n.ID, EventSlug: n.EventSlug, EventName: n.EventName.In(lang), Body: n.Body, CreatedAt: n.CreatedAt})
	}
	return apigen.AppListNotices200JSONResponse{Items: out}, nil
}

func boardToAPI(b Board) apigen.BroadcastBoard {
	counts := make([]apigen.BroadcastAudienceCount, 0, len(b.Audiences))
	for _, c := range b.Audiences {
		counts = append(counts, apigen.BroadcastAudienceCount{Audience: apigen.BroadcastAudience(c.Audience), Count: c.Count})
	}
	items := make([]apigen.BroadcastItem, 0, len(b.Items))
	for _, it := range b.Items {
		items = append(items, apigen.BroadcastItem{
			Id: it.ID, Audience: apigen.BroadcastAudience(it.Audience), Body: it.Body, RecipientCount: it.RecipientCount,
			SentCount: it.SentCount, FailedCount: it.FailedCount, SenderName: it.SenderName, CreatedAt: it.CreatedAt,
		})
	}
	return apigen.BroadcastBoard{Audiences: counts, Items: items}
}
