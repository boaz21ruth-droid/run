package promo

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/runner"
)

// Handlers 实现推荐链接与免费入场的接口。
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

func (h *Handlers) VisitReferral(ctx context.Context, req apigen.VisitReferralRequestObject) (apigen.VisitReferralResponseObject, error) {
	v, err := h.svc.VisitReferral(ctx, req.Slug)
	if err != nil {
		return nil, err
	}
	out := apigen.VisitReferral200JSONResponse{
		EventSlug:  v.EventSlug,
		Label:      v.Label,
		Kind:       apigen.ReferralKind(v.Kind),
		CouponCode: v.CouponCode,
	}
	if v.Offer != nil {
		out.Offer = &apigen.CouponOffer{DiscountType: apigen.DiscountType(v.Offer.DiscountType), DiscountValue: v.Offer.DiscountValue}
	}
	return out, nil
}

func compToAPI(c CompRequest) apigen.CompRequest {
	return apigen.CompRequest{
		Id:            c.ID,
		Status:        apigen.CompStatus(c.Status),
		Kind:          apigen.CompKind(c.Kind),
		ApplicantName: c.ApplicantName,
		ProfileUrl:    c.ProfileURL,
		Audience:      c.Audience,
		Note:          c.Note,
		CouponCode:    c.CouponCode,
		ReviewNote:    c.ReviewNote,
		CreatedAt:     c.CreatedAt,
	}
}

func adminCompToAPI(c CompRequest) apigen.AdminCompRequest {
	return apigen.AdminCompRequest{
		Id:               c.ID,
		Status:           apigen.CompStatus(c.Status),
		Kind:             apigen.CompKind(c.Kind),
		ApplicantName:    c.ApplicantName,
		ProfileUrl:       c.ProfileURL,
		Audience:         c.Audience,
		Note:             c.Note,
		CouponCode:       c.CouponCode,
		ReviewNote:       c.ReviewNote,
		CreatedAt:        c.CreatedAt,
		UserId:           c.UserID,
		TelegramUsername: c.TelegramUsername,
		CouponUsed:       c.CouponUsed,
		ReviewedAt:       c.ReviewedAt,
	}
}

func (h *Handlers) AppGetCompRequest(ctx context.Context, req apigen.AppGetCompRequestRequestObject) (apigen.AppGetCompRequestResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	st, err := h.svc.MyCompRequest(ctx, u, req.Slug)
	if err != nil {
		return nil, err
	}
	out := apigen.AppGetCompRequest200JSONResponse{Open: st.Open}
	if st.Request != nil {
		c := compToAPI(*st.Request)
		out.Request = &c
	}
	return out, nil
}

func (h *Handlers) AppCreateCompRequest(ctx context.Context, req apigen.AppCreateCompRequestRequestObject) (apigen.AppCreateCompRequestResponseObject, error) {
	u, err := runnerOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b := req.Body
	in := CompRequestInput{ApplicantName: b.ApplicantName, Kind: string(b.Kind)}
	if b.ProfileUrl != nil {
		in.ProfileURL = *b.ProfileUrl
	}
	if b.Audience != nil {
		in.Audience = *b.Audience
	}
	if b.Note != nil {
		in.Note = *b.Note
	}
	c, err := h.svc.CreateCompRequest(ctx, u, req.Slug, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateCompRequest201JSONResponse(compToAPI(c)), nil
}

func linkToAPI(l ReferralLink) apigen.ReferralLink {
	out := apigen.ReferralLink{
		Id:         l.ID,
		EventId:    l.EventID,
		Slug:       l.Slug,
		Label:      l.Label,
		Kind:       apigen.ReferralKind(l.Kind),
		Status:     apigen.CouponStatus(l.Status),
		ClickCount: l.ClickCount,
		Orders:     l.Orders,
		PaidOrders: l.PaidOrders,
		CreatedAt:  l.CreatedAt,
	}
	if c := l.Coupon; c != nil {
		out.Coupon = &apigen.ReferralCoupon{
			Id:            c.ID,
			Code:          c.Code,
			DiscountType:  apigen.DiscountType(c.Offer.DiscountType),
			DiscountValue: c.Offer.DiscountValue,
			Quota:         c.Quota,
			UsedCount:     c.UsedCount,
			ReservedCount: c.ReservedCount,
			Status:        apigen.CouponStatus(c.Status),
		}
	}
	return out
}

func (h *Handlers) AdminListReferralLinks(ctx context.Context, req apigen.AdminListReferralLinksRequestObject) (apigen.AdminListReferralLinksResponseObject, error) {
	st, err := h.svc.ListReferralLinks(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	out := apigen.AdminListReferralLinks200JSONResponse{
		Items:            make([]apigen.ReferralLink, 0, len(st.Links)),
		DirectOrders:     st.DirectOrders,
		DirectPaidOrders: st.DirectPaidOrders,
	}
	for _, l := range st.Links {
		out.Items = append(out.Items, linkToAPI(l))
	}
	return out, nil
}

func (h *Handlers) AdminCreateReferralLink(ctx context.Context, req apigen.AdminCreateReferralLinkRequestObject) (apigen.AdminCreateReferralLinkResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	b := req.Body
	in := ReferralLinkInput{Slug: b.Slug, Label: b.Label, Kind: string(b.Kind)}
	if o := b.Offer; o != nil {
		in.Offer = &OfferInput{
			Code:  o.Code,
			Offer: Offer{DiscountType: string(o.DiscountType), DiscountValue: o.DiscountValue},
			Quota: o.Quota,
		}
	}
	l, err := h.svc.CreateReferralLink(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreateReferralLink201JSONResponse(linkToAPI(l)), nil
}

func (h *Handlers) AdminUpdateReferralLink(ctx context.Context, req apigen.AdminUpdateReferralLinkRequestObject) (apigen.AdminUpdateReferralLinkResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	l, err := h.svc.UpdateReferralLink(ctx, actor, req.Id, req.Body.Label, string(req.Body.Status))
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateReferralLink200JSONResponse(linkToAPI(l)), nil
}

func compListToAPI(l CompList) apigen.CompRequestList {
	out := apigen.CompRequestList{Quota: l.Quota, Approved: l.Approved, Pending: l.Pending, Items: make([]apigen.AdminCompRequest, 0, len(l.Items))}
	for _, c := range l.Items {
		out.Items = append(out.Items, adminCompToAPI(c))
	}
	return out
}

func (h *Handlers) AdminListCompRequests(ctx context.Context, req apigen.AdminListCompRequestsRequestObject) (apigen.AdminListCompRequestsResponseObject, error) {
	l, err := h.svc.ListCompRequests(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminListCompRequests200JSONResponse(compListToAPI(l)), nil
}

func (h *Handlers) AdminUpdateCompQuota(ctx context.Context, req apigen.AdminUpdateCompQuotaRequestObject) (apigen.AdminUpdateCompQuotaResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest()
	}
	l, err := h.svc.UpdateCompQuota(ctx, actor, req.Id, req.Body.Quota)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdateCompQuota200JSONResponse(compListToAPI(l)), nil
}

func (h *Handlers) AdminApproveCompRequest(ctx context.Context, req apigen.AdminApproveCompRequestRequestObject) (apigen.AdminApproveCompRequestResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	c, err := h.svc.ApproveCompRequest(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminApproveCompRequest200JSONResponse(adminCompToAPI(c)), nil
}

func (h *Handlers) AdminRejectCompRequest(ctx context.Context, req apigen.AdminRejectCompRequestRequestObject) (apigen.AdminRejectCompRequestResponseObject, error) {
	actor, err := actorOf(ctx)
	if err != nil {
		return nil, err
	}
	note := ""
	if req.Body != nil && req.Body.Note != nil {
		note = *req.Body.Note
	}
	c, err := h.svc.RejectCompRequest(ctx, actor, req.Id, note)
	if err != nil {
		return nil, err
	}
	return apigen.AdminRejectCompRequest200JSONResponse(adminCompToAPI(c)), nil
}
