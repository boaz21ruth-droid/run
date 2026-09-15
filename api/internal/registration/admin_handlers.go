package registration

import (
	"context"

	"werun/api/internal/httpapi/apigen"
)

func (h *Handlers) AdminListOrders(ctx context.Context, req apigen.AdminListOrdersRequestObject) (apigen.AdminListOrdersResponseObject, error) {
	f := AdminOrderFilter{EventID: req.Params.EventId}
	if req.Params.Status != nil {
		f.Status = string(*req.Params.Status)
	}
	if req.Params.Q != nil {
		f.Query = *req.Params.Q
	}
	if req.Params.Limit != nil {
		f.Limit = *req.Params.Limit
	}
	if req.Params.Offset != nil {
		f.Offset = *req.Params.Offset
	}
	items, total, err := h.svc.AdminListOrders(ctx, f)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.AdminOrderSummary, 0, len(items))
	for _, o := range items {
		out = append(out, apigen.AdminOrderSummary{
			Id:               o.ID,
			OrderNo:          o.OrderNo,
			EventId:          o.EventID,
			EventSlug:        o.EventSlug,
			EventName:        localizedToAPI(o.EventName),
			Status:           apigen.AdminOrderSummaryStatus(o.Status),
			ListAmountCents:  o.ListAmountCents,
			DiscountCents:    o.DiscountCents,
			IdentOffsetCents: o.IdentOffsetCents,
			AmountCents:      o.AmountCents,
			Currency:         o.Currency,
			ParticipantCount: int32(o.ParticipantCount),
			DeadlineAt:       o.DeadlineAt,
			PaidAt:           o.PaidAt,
			CreatedAt:        o.CreatedAt,
		})
	}
	return apigen.AdminListOrders200JSONResponse{Items: out, Total: total}, nil
}

func (h *Handlers) AdminGetOrder(ctx context.Context, req apigen.AdminGetOrderRequestObject) (apigen.AdminGetOrderResponseObject, error) {
	d, err := h.svc.AdminGetOrder(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetOrder200JSONResponse(AdminOrderDetailToAPI(d)), nil
}

// AdminOrderDetailToAPI 把后台订单详情转换为 OpenAPI 结构；payment 的凭证详情接口复用。
func AdminOrderDetailToAPI(d AdminOrderDetail) apigen.AdminOrderDetail {
	participants := make([]apigen.AdminOrderParticipant, 0, len(d.Participants))
	for _, p := range d.Participants {
		participants = append(participants, apigen.AdminOrderParticipant{
			RegistrationId:     p.RegistrationID,
			RegNo:              p.RegNo,
			CategoryId:         p.CategoryID,
			CategoryName:       localizedToAPI(p.CategoryName),
			FullName:           p.FullName,
			PriceRuleId:        p.PriceRuleID,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: apigen.AdminOrderParticipantRegistrationStatus(p.RegistrationStatus),
			TicketCode:         p.TicketCode,
		})
	}
	proofs := make([]apigen.AdminProofHistoryItem, 0, len(d.Proofs))
	for _, p := range d.Proofs {
		proofs = append(proofs, apigen.AdminProofHistoryItem{
			Id:                  p.ID,
			ProofNo:             p.ProofNo,
			Status:              apigen.AdminProofHistoryItemStatus(p.Status),
			BankTxnRef:          p.BankTxnRef,
			DeclaredAmountCents: p.DeclaredAmountCents,
			RejectCode:          p.RejectCode,
			CreatedAt:           p.CreatedAt,
			ReviewedAt:          p.ReviewedAt,
		})
	}
	receipts := make([]apigen.AdminReceiptItem, 0, len(d.Receipts))
	for _, r := range d.Receipts {
		receipts = append(receipts, apigen.AdminReceiptItem{
			Id:          r.ID,
			TxnRef:      r.TxnRef,
			AmountCents: r.AmountCents,
			ReceivedAt:  r.ReceivedAt,
			MatchStatus: apigen.AdminReceiptItemMatchStatus(r.MatchStatus),
		})
	}
	out := apigen.AdminOrderDetail{
		Id:               d.ID,
		OrderNo:          d.OrderNo,
		EventId:          d.EventID,
		EventSlug:        d.EventSlug,
		EventName:        localizedToAPI(d.EventName),
		EventTimezone:    d.EventTimezone,
		Status:           apigen.AdminOrderDetailStatus(d.Status),
		ReservationState: apigen.AdminOrderDetailReservationState(d.ReservationState),
		BuyerName:        d.BuyerName,
		BuyerPhone:       d.BuyerPhone,
		ListAmountCents:  d.ListAmountCents,
		DiscountCents:    d.DiscountCents,
		IdentOffsetCents: d.IdentOffsetCents,
		AmountCents:      d.AmountCents,
		Currency:         d.Currency,
		DeadlineAt:       d.DeadlineAt,
		PaidAt:           d.PaidAt,
		CreatedAt:        d.CreatedAt,
		PaymentAccount: apigen.AdminOrderPaymentAccount{
			Id:              d.PaymentAccount.ID,
			Name:            d.PaymentAccount.Name,
			Provider:        d.PaymentAccount.Provider,
			AccountName:     d.PaymentAccount.AccountName,
			AccountNoMasked: d.PaymentAccount.AccountNoMasked,
			QrFileId:        d.PaymentAccount.QRFileID,
		},
		Participants: participants,
		Proofs:       proofs,
		Receipts:     receipts,
	}
	if d.LastRejection != nil {
		out.LastRejection = &apigen.AdminLastRejection{
			Code:       d.LastRejection.Code,
			Reason:     d.LastRejection.Reason,
			ReviewedAt: d.LastRejection.ReviewedAt,
		}
	}
	if d.Coupon != nil {
		out.Coupon = &apigen.AdminAppliedCoupon{
			Code:          d.Coupon.Code,
			DiscountCents: d.Coupon.DiscountCents,
			State:         apigen.AdminAppliedCouponState(d.Coupon.State),
		}
	}
	return out
}
