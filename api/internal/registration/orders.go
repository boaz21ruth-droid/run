package registration

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/registration/store"
)

// loadDetail 读取订单详情（订单、赛事、参赛人、收款账户、最近一次驳回）。
func (s *Service) loadDetail(ctx context.Context, q *store.Queries, orderID int64) (OrderDetail, error) {
	row, err := q.GetOrderDetailByID(ctx, orderID)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("load order %d: %w", orderID, err)
	}
	eventName, err := decodeText(row.EventName, "event name")
	if err != nil {
		return OrderDetail{}, err
	}
	d := OrderDetail{
		Order: Order{
			ID:               row.ID,
			EventID:          row.EventID,
			OrderNo:          row.OrderNo,
			Status:           row.Status,
			ReservationState: row.ReservationState,
			ListAmountCents:  row.ListAmountCents,
			DiscountCents:    row.DiscountCents,
			IdentOffsetCents: int64(row.IdentOffsetCents),
			AmountCents:      row.AmountCents,
			Currency:         row.Currency,
			DeadlineAt:       row.DeadlineAt,
			PaidAt:           row.PaidAt,
			CreatedAt:        row.CreatedAt,
		},
		EventSlug:     row.EventSlug,
		EventName:     eventName,
		EventTimezone: row.EventTimezone,
	}
	if row.BuyerUserID != nil {
		d.BuyerUserID = *row.BuyerUserID
	}

	parts, err := q.ListOrderParticipantDetails(ctx, orderID)
	if err != nil {
		return OrderDetail{}, fmt.Errorf("list participants of order %d: %w", orderID, err)
	}
	d.Participants = make([]OrderParticipant, 0, len(parts))
	for _, p := range parts {
		catName, err := decodeText(p.CategoryName, "category name")
		if err != nil {
			return OrderDetail{}, err
		}
		op := OrderParticipant{
			RegistrationID:     p.RegistrationID,
			RegNo:              p.RegNo,
			CategoryID:         p.CategoryID,
			CategoryName:       catName,
			FullName:           p.FullName,
			PriceRuleID:        p.PriceRuleID,
			ListPriceCents:     p.ListPriceCents,
			PaidCents:          p.PaidCents,
			RegistrationStatus: p.RegistrationStatus,
		}
		if p.RegistrationStatus == RegistrationConfirmed {
			code := p.TicketCode
			op.TicketCode = &code
		}
		d.Participants = append(d.Participants, op)
	}

	if row.PaymentAccountID != nil {
		d.PaymentAccountID = *row.PaymentAccountID
		acct, err := q.GetOrderPaymentAccount(ctx, *row.PaymentAccountID)
		if err != nil {
			return OrderDetail{}, fmt.Errorf("load payment account of order %d: %w", orderID, err)
		}
		d.PaymentAccount = PaymentAccountView{
			ID:              acct.ID,
			Name:            acct.Name,
			Provider:        acct.Provider,
			AccountName:     acct.AccountName,
			AccountNoMasked: acct.AccountNoMasked,
			QRFileID:        acct.QrFileID,
		}
	}

	rej, err := q.GetLastRejectedProof(ctx, orderID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return OrderDetail{}, fmt.Errorf("load last rejection of order %d: %w", orderID, err)
	case rej.RejectCode != nil && rej.ReviewedAt != nil:
		d.LastRejection = &LastRejection{Code: *rej.RejectCode, Reason: rej.RejectReason, ReviewedAt: *rej.ReviewedAt}
	}
	return d, nil
}
