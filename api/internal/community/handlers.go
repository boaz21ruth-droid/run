package community

import (
	"context"
	"fmt"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/runner"
)

// Handlers 实现跑团页接口。
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

func (h *Handlers) GetCommunityFeed(ctx context.Context, req apigen.GetCommunityFeedRequestObject) (apigen.GetCommunityFeedResponseObject, error) {
	kind, city := "", ""
	if req.Params.Kind != nil && *req.Params.Kind != apigen.GetCommunityFeedParamsKindALL {
		kind = string(*req.Params.Kind)
	}
	if req.Params.City != nil {
		city = *req.Params.City
	}
	f, err := h.svc.Feed(ctx, kind, city)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.CommunityFeedItem, 0, len(f.Items))
	for _, it := range f.Items {
		var tag *apigen.CommunityTag
		if it.Tag != nil {
			t := apigen.CommunityTag(*it.Tag)
			tag = &t
		}
		items = append(items, apigen.CommunityFeedItem{
			Kind: apigen.CommunityFeedItemKind(it.Kind), Id: it.ID, EventSlug: it.EventSlug, Title: it.Title, StartsAt: it.StartsAt,
			City: it.City, Location: it.Location, HostName: it.HostName, Tag: tag, DistanceText: it.DistanceText,
			Capacity: it.Capacity, JoinedCount: it.JoinedCount, WaitlistCount: it.WaitlistCount, FeeNote: it.FeeNote,
			CoverUrl: coverURLOf(it.CoverFileID), JoinerInitials: it.JoinerInitials,
		})
	}
	return apigen.GetCommunityFeed200JSONResponse{Items: items, Checkins: checkinsToAPI(f.Checkins), Cities: f.Cities}, nil
}

func (h *Handlers) GetCommunityActivity(ctx context.Context, req apigen.GetCommunityActivityRequestObject) (apigen.GetCommunityActivityResponseObject, error) {
	a, err := h.svc.GetPublic(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.GetCommunityActivity200JSONResponse(activityToAPI(a)), nil
}

func (h *Handlers) AppCreateCommunityActivity(ctx context.Context, req apigen.AppCreateCommunityActivityRequestObject) (apigen.AppCreateCommunityActivityResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b := req.Body
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	a, err := h.svc.Create(ctx, u, CreateInput{
		Title: b.Title, Tag: string(b.Tag), StartsAt: b.StartsAt, City: deref(b.City), Location: b.Location, MeetPoint: b.MeetPoint,
		DistanceText: deref(b.DistanceText), Capacity: b.Capacity, FeeNote: deref(b.FeeNote), HostName: deref(b.HostName),
		ContactTelegram: deref(b.ContactTelegram), ContactPhone: deref(b.ContactPhone), ContactVisibility: string(b.ContactVisibility),
		Body:    b.Body,
		Consent: runner.ConsentAcceptance{Version: b.Consent.Version, Lang: string(b.Consent.Lang), CheckedItems: b.Consent.CheckedItems},
	}, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateCommunityActivity201JSONResponse(activityToAPI(a)), nil
}

func (h *Handlers) AppListMyCommunityActivities(ctx context.Context, _ apigen.AppListMyCommunityActivitiesRequestObject) (apigen.AppListMyCommunityActivitiesResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	items, err := h.svc.Mine(ctx, u)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.CommunityActivity, 0, len(items))
	for _, a := range items {
		out = append(out, activityToAPI(a))
	}
	return apigen.AppListMyCommunityActivities200JSONResponse{Items: out}, nil
}

func (h *Handlers) AppGetCommunityActivityMe(ctx context.Context, req apigen.AppGetCommunityActivityMeRequestObject) (apigen.AppGetCommunityActivityMeResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	v, err := h.svc.ViewFor(ctx, u, req.Id, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppGetCommunityActivityMe200JSONResponse(viewToAPI(v)), nil
}

func (h *Handlers) AppJoinCommunityActivity(ctx context.Context, req apigen.AppJoinCommunityActivityRequestObject) (apigen.AppJoinCommunityActivityResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	v, err := h.svc.Join(ctx, u, req.Id, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppJoinCommunityActivity200JSONResponse(viewToAPI(v)), nil
}

func (h *Handlers) AppLeaveCommunityActivity(ctx context.Context, req apigen.AppLeaveCommunityActivityRequestObject) (apigen.AppLeaveCommunityActivityResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	v, err := h.svc.Leave(ctx, u, req.Id, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppLeaveCommunityActivity200JSONResponse(viewToAPI(v)), nil
}

func (h *Handlers) AppCloseCommunityActivity(ctx context.Context, req apigen.AppCloseCommunityActivityRequestObject) (apigen.AppCloseCommunityActivityResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	v, err := h.svc.Close(ctx, u, req.Id, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCloseCommunityActivity200JSONResponse(viewToAPI(v)), nil
}

func (h *Handlers) AppGetCommunityCheckin(ctx context.Context, _ apigen.AppGetCommunityCheckinRequestObject) (apigen.AppGetCommunityCheckinResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	st, err := h.svc.CheckinState(ctx, u)
	if err != nil {
		return nil, err
	}
	return apigen.AppGetCommunityCheckin200JSONResponse(checkinStateToAPI(st)), nil
}

func (h *Handlers) AppCommunityCheckin(ctx context.Context, req apigen.AppCommunityCheckinRequestObject) (apigen.AppCommunityCheckinResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	var city string
	if req.Body != nil && req.Body.City != nil {
		city = *req.Body.City
	}
	st, err := h.svc.Checkin(ctx, u, city)
	if err != nil {
		return nil, err
	}
	return apigen.AppCommunityCheckin200JSONResponse(checkinStateToAPI(st)), nil
}

func (h *Handlers) AppCommunityCheckout(ctx context.Context, _ apigen.AppCommunityCheckoutRequestObject) (apigen.AppCommunityCheckoutResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	st, err := h.svc.Checkout(ctx, u)
	if err != nil {
		return nil, err
	}
	return apigen.AppCommunityCheckout200JSONResponse(checkinStateToAPI(st)), nil
}

func (h *Handlers) AdminListCommunityActivities(ctx context.Context, req apigen.AdminListCommunityActivitiesRequestObject) (apigen.AdminListCommunityActivitiesResponseObject, error) {
	var status string
	if req.Params.Status != nil {
		status = string(*req.Params.Status)
	}
	items, telegrams, err := h.svc.AdminList(ctx, status)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.AdminCommunityActivity, 0, len(items))
	for i, a := range items {
		out = append(out, adminToAPI(a, telegrams[i]))
	}
	return apigen.AdminListCommunityActivities200JSONResponse{Items: out}, nil
}

func (h *Handlers) AdminApproveCommunityActivity(ctx context.Context, req apigen.AdminApproveCommunityActivityRequestObject) (apigen.AdminApproveCommunityActivityResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	a, err := h.svc.Approve(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminApproveCommunityActivity200JSONResponse(adminToAPI(a, nil)), nil
}

func (h *Handlers) AdminRejectCommunityActivity(ctx context.Context, req apigen.AdminRejectCommunityActivityRequestObject) (apigen.AdminRejectCommunityActivityResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	a, err := h.svc.Reject(ctx, actor, req.Id, string(req.Body.Code))
	if err != nil {
		return nil, err
	}
	return apigen.AdminRejectCommunityActivity200JSONResponse(adminToAPI(a, nil)), nil
}

func (h *Handlers) AdminFreezeCommunityActivity(ctx context.Context, req apigen.AdminFreezeCommunityActivityRequestObject) (apigen.AdminFreezeCommunityActivityResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	a, err := h.svc.Freeze(ctx, actor, req.Id, req.Body.Reason)
	if err != nil {
		return nil, err
	}
	return apigen.AdminFreezeCommunityActivity200JSONResponse(adminToAPI(a, nil)), nil
}

func (h *Handlers) AdminUnfreezeCommunityActivity(ctx context.Context, req apigen.AdminUnfreezeCommunityActivityRequestObject) (apigen.AdminUnfreezeCommunityActivityResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	a, err := h.svc.Unfreeze(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUnfreezeCommunityActivity200JSONResponse(adminToAPI(a, nil)), nil
}

func activityToAPI(a Activity) apigen.CommunityActivity {
	return apigen.CommunityActivity{
		Id: a.ID, Title: a.Title, Tag: apigen.CommunityTag(a.Tag), StartsAt: a.StartsAt, City: a.City, Location: a.Location,
		MeetPoint: a.MeetPoint, DistanceText: a.DistanceText, Capacity: a.Capacity, JoinedCount: a.JoinedCount,
		WaitlistCount: a.WaitlistCount, FeeNote: a.FeeNote, HostName: a.HostName, AuthorName: a.AuthorName, Body: a.Body,
		ContactVisibility: apigen.CommunityActivityContactVisibility(a.ContactVisibility), Status: apigen.CommunityStatus(a.Status),
		RejectCode: a.RejectCode, Frozen: a.Frozen, JoinerInitials: a.JoinerInitials,
	}
}

func viewToAPI(v View) apigen.CommunityActivityView {
	out := apigen.CommunityActivityView{
		Activity: activityToAPI(v.Activity), MyStatus: apigen.CommunityActivityViewMyStatus(v.MyStatus), IsAuthor: v.IsAuthor,
	}
	if v.Contact != nil {
		out.Contact = &apigen.CommunityContact{Telegram: v.Contact.Telegram, Phone: v.Contact.Phone}
	}
	return out
}

func adminToAPI(a Activity, authorTelegram *string) apigen.AdminCommunityActivity {
	return apigen.AdminCommunityActivity{
		Activity: activityToAPI(a), AuthorTelegram: authorTelegram, ContactTelegram: a.ContactTelegram,
		ContactPhone: a.ContactPhone, ReviewRequired: a.ReviewRequired, FreezeReason: a.FreezeReason, CreatedAt: a.CreatedAt,
	}
}

func checkinsToAPI(in []Checkin) []apigen.CommunityCheckin {
	out := make([]apigen.CommunityCheckin, 0, len(in))
	for _, c := range in {
		out = append(out, apigen.CommunityCheckin{Name: c.Name, Initials: c.Initials})
	}
	return out
}

func checkinStateToAPI(st CheckinState) apigen.CommunityCheckinState {
	return apigen.CommunityCheckinState{CheckedIn: st.CheckedIn, Checkins: checkinsToAPI(st.Checkins)}
}

// coverURLOf 与 event 包一致：/api/files/{id}。
func coverURLOf(fileID *int64) *string {
	if fileID == nil {
		return nil
	}
	url := fmt.Sprintf("/api/files/%d", *fileID)
	return &url
}
