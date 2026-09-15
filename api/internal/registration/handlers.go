package registration

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/runner"
)

// Handlers 实现 apigen.StrictServerInterface 中的跑者订单操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建订单 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func currentRunner(ctx context.Context) (runner.User, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return runner.User{}, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	return u, nil
}

// AppQuote 返回算价预览。
func (h *Handlers) AppQuote(ctx context.Context, req apigen.AppQuoteRequestObject) (apigen.AppQuoteResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in := QuotePreviewInput{}
	if req.Body.CouponCode != nil {
		in.CouponCode = *req.Body.CouponCode
	}
	for _, p := range req.Body.Participants {
		in.Participants = append(in.Participants, pricing.ParticipantInput{
			CategoryID: p.CategoryId, Nationality: p.Nationality, BirthDate: p.BirthDate.Time})
	}
	q, err := h.svc.PreviewQuote(ctx, u, req.Slug, in)
	if err != nil {
		return nil, err
	}
	return apigen.AppQuote200JSONResponse(toAPIQuote(q)), nil
}

// AppCreateOrder 下单。
func (h *Handlers) AppCreateOrder(ctx context.Context, req apigen.AppCreateOrderRequestObject) (apigen.AppCreateOrderResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	d, err := h.svc.CreateOrder(ctx, u, createInputFromAPI(*req.Body, req.Params.IdempotencyKey), httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCreateOrder201JSONResponse(toAPIOrderDetail(d)), nil
}

func createInputFromAPI(b apigen.CreateOrderRequest, key string) CreateOrderInput {
	in := CreateOrderInput{
		EventSlug:      b.EventSlug,
		IdempotencyKey: key,
		Consent: runner.ConsentAcceptance{
			Version:      b.Consent.Version,
			Lang:         string(b.Consent.Lang),
			CheckedItems: b.Consent.CheckedItems,
		},
	}
	if b.CouponCode != nil {
		in.CouponCode = *b.CouponCode
	}
	for _, p := range b.Participants {
		op := OrderParticipantInput{CategoryID: p.CategoryId, ProfileID: p.ProfileId}
		if p.SaveAsProfile != nil {
			op.SaveAsProfile = *p.SaveAsProfile
		}
		if p.Profile != nil {
			prof := runner.ProfileData{
				FullName:       p.Profile.FullName,
				Gender:         string(p.Profile.Gender),
				BirthDate:      p.Profile.BirthDate.Time,
				Nationality:    p.Profile.Nationality,
				IDType:         string(p.Profile.IdType),
				IDNo:           p.Profile.IdNo,
				Phone:          p.Profile.Phone,
				EmergencyName:  p.Profile.EmergencyName,
				EmergencyPhone: p.Profile.EmergencyPhone,
				TShirtSize:     string(p.Profile.TshirtSize),
			}
			if p.Profile.Email != nil {
				prof.Email = *p.Profile.Email
			}
			op.Profile = &prof
		}
		in.Participants = append(in.Participants, op)
	}
	return in
}

func toAPIQuote(q pricing.Quote) apigen.Quote {
	parts := make([]apigen.QuoteParticipant, 0, len(q.Participants))
	for _, p := range q.Participants {
		parts = append(parts, apigen.QuoteParticipant{
			CategoryId:     p.CategoryID,
			PriceRuleId:    p.PriceRuleID,
			Audience:       apigen.QuoteParticipantAudience(p.Audience),
			ListPriceCents: p.ListPriceCents,
			PaidCents:      p.PaidCents,
		})
	}
	return apigen.Quote{
		Participants:        parts,
		ListAmountCents:     q.ListAmountCents,
		CouponApplied:       q.CouponID != nil,
		CouponDiscountCents: q.CouponDiscountCents,
		IdentOffsetCents:    q.IdentOffsetCents,
		DiscountCents:       q.DiscountCents,
		AmountCents:         q.AmountCents,
		Currency:            q.Currency,
	}
}

func toAPIOrderDetail(d OrderDetail) apigen.OrderDetail {
	parts := make([]apigen.OrderParticipant, 0, len(d.Participants))
	for _, p := range d.Participants {
		parts = append(parts, apigen.OrderParticipant{
			RegNo:              p.RegNo,
			CategoryId:         p.CategoryID,
			CategoryName:       localizedToAPI(p.CategoryName),
			FullName:           p.FullName,
			PriceRuleId:        p.PriceRuleID,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: apigen.OrderParticipantRegistrationStatus(p.RegistrationStatus),
			TicketCode:         p.TicketCode,
		})
	}
	out := apigen.OrderDetail{
		OrderNo:          d.OrderNo,
		Status:           apigen.OrderStatus(d.Status),
		EventSlug:        d.EventSlug,
		EventName:        localizedToAPI(d.EventName),
		EventTimezone:    d.EventTimezone,
		ListAmountCents:  d.ListAmountCents,
		DiscountCents:    d.DiscountCents,
		IdentOffsetCents: d.IdentOffsetCents,
		AmountCents:      d.AmountCents,
		Currency:         d.Currency,
		DeadlineAt:       d.DeadlineAt,
		PaidAt:           d.PaidAt,
		CreatedAt:        d.CreatedAt,
		Participants:     parts,
		PaymentAccount: apigen.OrderPaymentAccount{
			Id:              d.PaymentAccount.ID,
			Name:            d.PaymentAccount.Name,
			Provider:        d.PaymentAccount.Provider,
			AccountName:     d.PaymentAccount.AccountName,
			AccountNoMasked: d.PaymentAccount.AccountNoMasked,
			QrFileId:        d.PaymentAccount.QRFileID,
		},
	}
	if d.LastRejection != nil {
		out.LastRejection = &apigen.OrderRejection{
			Code:       d.LastRejection.Code,
			Reason:     d.LastRejection.Reason,
			ReviewedAt: d.LastRejection.ReviewedAt,
		}
	}
	return out
}

// orderDetailFromAPI 是 toAPIOrderDetail 的逆变换，只还原接口里暴露的字段（用于幂等重放）。
func orderDetailFromAPI(a apigen.OrderDetail) OrderDetail {
	d := OrderDetail{
		Order: Order{
			OrderNo:          a.OrderNo,
			Status:           string(a.Status),
			ListAmountCents:  a.ListAmountCents,
			DiscountCents:    a.DiscountCents,
			IdentOffsetCents: a.IdentOffsetCents,
			AmountCents:      a.AmountCents,
			Currency:         a.Currency,
			PaymentAccountID: a.PaymentAccount.Id,
			DeadlineAt:       a.DeadlineAt,
			PaidAt:           a.PaidAt,
			CreatedAt:        a.CreatedAt,
		},
		EventSlug:     a.EventSlug,
		EventName:     localizedFromAPI(a.EventName),
		EventTimezone: a.EventTimezone,
		PaymentAccount: PaymentAccountView{
			ID:              a.PaymentAccount.Id,
			Name:            a.PaymentAccount.Name,
			Provider:        a.PaymentAccount.Provider,
			AccountName:     a.PaymentAccount.AccountName,
			AccountNoMasked: a.PaymentAccount.AccountNoMasked,
			QRFileID:        a.PaymentAccount.QrFileId,
		},
	}
	for _, p := range a.Participants {
		d.Participants = append(d.Participants, OrderParticipant{
			RegNo:              p.RegNo,
			CategoryID:         p.CategoryId,
			CategoryName:       localizedFromAPI(p.CategoryName),
			FullName:           p.FullName,
			PriceRuleID:        p.PriceRuleId,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: string(p.RegistrationStatus),
			TicketCode:         p.TicketCode,
		})
	}
	if a.LastRejection != nil {
		d.LastRejection = &LastRejection{Code: a.LastRejection.Code, Reason: a.LastRejection.Reason, ReviewedAt: a.LastRejection.ReviewedAt}
	}
	return d
}

func (h *Handlers) AppListOrders(ctx context.Context, _ apigen.AppListOrdersRequestObject) (apigen.AppListOrdersResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	orders, err := h.svc.ListMyOrders(ctx, u)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.OrderSummary, 0, len(orders))
	for _, o := range orders {
		items = append(items, toAPIOrderSummary(o))
	}
	return apigen.AppListOrders200JSONResponse{Items: items}, nil
}

func (h *Handlers) AppGetOrder(ctx context.Context, req apigen.AppGetOrderRequestObject) (apigen.AppGetOrderResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	d, err := h.svc.GetMyOrder(ctx, u, req.OrderNo)
	if err != nil {
		return nil, err
	}
	return apigen.AppGetOrder200JSONResponse(toAPIOrderDetail(d)), nil
}

func (h *Handlers) AppCancelOrder(ctx context.Context, req apigen.AppCancelOrderRequestObject) (apigen.AppCancelOrderResponseObject, error) {
	u, err := currentRunner(ctx)
	if err != nil {
		return nil, err
	}
	d, err := h.svc.CancelOrder(ctx, u, req.OrderNo, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppCancelOrder200JSONResponse(toAPIOrderDetail(d)), nil
}

func toAPIOrderSummary(o OrderSummary) apigen.OrderSummary {
	return apigen.OrderSummary{
		OrderNo:          o.OrderNo,
		Status:           apigen.OrderStatus(o.Status),
		EventSlug:        o.EventSlug,
		EventName:        localizedToAPI(o.EventName),
		AmountCents:      o.AmountCents,
		Currency:         o.Currency,
		ParticipantCount: int32(o.ParticipantCount),
		DeadlineAt:       o.DeadlineAt,
		CreatedAt:        o.CreatedAt,
	}
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

func localizedFromAPI(l apigen.LocalizedText) i18n.Text {
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
