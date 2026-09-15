package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/registration/store"
	"werun/api/internal/runner"
)

// ReleaseKind 是释放预留的原因，同时写入 reg_orders.reservation_release_kind 与 registrations.cancel_reason。
type ReleaseKind string

const (
	ReleaseExpired   ReleaseKind = "ORDER_EXPIRED"
	ReleaseCancelled ReleaseKind = "ORDER_CANCELLED"
)

func orderNotFound() error {
	return apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
}

// ListMyOrders 返回当前跑者最近 100 张订单，新的在前。
func (s *Service) ListMyOrders(ctx context.Context, u runner.User) ([]OrderSummary, error) {
	rows, err := store.New(s.pool).ListOrdersForBuyer(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("list orders of user %d: %w", u.ID, err)
	}
	out := make([]OrderSummary, 0, len(rows))
	for _, r := range rows {
		name, err := decodeText(r.EventName, "event name")
		if err != nil {
			return nil, err
		}
		sum := OrderSummary{
			Order: Order{
				ID:               r.ID,
				EventID:          r.EventID,
				OrderNo:          r.OrderNo,
				Status:           r.Status,
				ReservationState: r.ReservationState,
				ListAmountCents:  r.ListAmountCents,
				DiscountCents:    r.DiscountCents,
				IdentOffsetCents: int64(r.IdentOffsetCents),
				AmountCents:      r.AmountCents,
				Currency:         r.Currency,
				DeadlineAt:       r.DeadlineAt,
				PaidAt:           r.PaidAt,
				CreatedAt:        r.CreatedAt,
			},
			EventSlug:        r.EventSlug,
			EventName:        name,
			ParticipantCount: int(r.ParticipantCount),
		}
		if r.BuyerUserID != nil {
			sum.BuyerUserID = *r.BuyerUserID
		}
		if r.PaymentAccountID != nil {
			sum.PaymentAccountID = *r.PaymentAccountID
		}
		out = append(out, sum)
	}
	return out, nil
}

// GetMyOrder 返回当前跑者的订单详情；订单不存在或不属于该跑者返回 ORDER_NOT_FOUND。
func (s *Service) GetMyOrder(ctx context.Context, u runner.User, orderNo string) (OrderDetail, error) {
	q := store.New(s.pool)
	id, err := q.GetOrderIDForBuyer(ctx, store.GetOrderIDForBuyerParams{OrderNo: orderNo, BuyerUserID: u.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderDetail{}, orderNotFound()
	}
	if err != nil {
		return OrderDetail{}, fmt.Errorf("find order %q: %w", orderNo, err)
	}
	return s.loadDetail(ctx, q, id)
}

// CancelOrder 取消付款前（PENDING_PAYMENT）的订单并释放名额，写审计 reg_order.cancel，不推送。
func (s *Service) CancelOrder(ctx context.Context, u runner.User, orderNo string, meta httpx.Meta) (OrderDetail, error) {
	var out OrderDetail
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.LockOrderForBuyer(ctx, store.LockOrderForBuyerParams{OrderNo: orderNo, BuyerUserID: u.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return orderNotFound()
		}
		if err != nil {
			return fmt.Errorf("lock order %q: %w", orderNo, err)
		}
		if row.Status != StatusPendingPayment {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		released, err := s.ReleaseOrder(ctx, tx, row.ID, ReleaseCancelled)
		if err != nil {
			return err
		}
		if !released {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		if err := audit.Record(ctx, tx, runnerAudit(u, "reg_order.cancel", row.ID, row.EventID,
			fmt.Sprintf("跑者取消订单 %s", orderNo),
			map[string]any{"orderNo": orderNo, "status": StatusCancelled}, meta)); err != nil {
			return err
		}
		detail, err := s.loadDetail(ctx, q, row.ID)
		out = detail
		return err
	})
	if err != nil {
		return OrderDetail{}, err
	}
	return out, nil
}

// ReleaseOrder 用条件更新结束订单预留（超时：PENDING_PAYMENT/PROOF_REJECTED → EXPIRED；取消：PENDING_PAYMENT → CANCELLED）。
// 只有影响 1 行时才释放计数、把 PENDING 报名改为 CANCELLED 并返回 true；重复调用返回 false 且不改任何数据。
func (s *Service) ReleaseOrder(ctx context.Context, tx pgx.Tx, orderID int64, kind ReleaseKind) (bool, error) {
	q := store.New(tx)
	at := s.now().UTC()
	var (
		n   int64
		err error
	)
	switch kind {
	case ReleaseExpired:
		n, err = q.ReleaseOrderExpired(ctx, store.ReleaseOrderExpiredParams{At: at, ID: orderID})
	case ReleaseCancelled:
		n, err = q.ReleaseOrderCancelled(ctx, store.ReleaseOrderCancelledParams{At: at, ID: orderID})
	default:
		return false, fmt.Errorf("release order %d: unknown kind %q", orderID, kind)
	}
	if err != nil {
		return false, fmt.Errorf("release order %d: %w", orderID, err)
	}
	if n == 0 {
		return false, nil
	}
	if err := s.prices.Release(ctx, tx, orderID); err != nil {
		return false, err
	}
	if _, err := q.CancelOrderRegistrations(ctx, store.CancelOrderRegistrationsParams{
		CancelReason: string(kind),
		OrderID:      orderID,
	}); err != nil {
		return false, fmt.Errorf("cancel registrations of order %d: %w", orderID, err)
	}
	return true, nil
}

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
