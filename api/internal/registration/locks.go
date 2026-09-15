package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/registration/store"
)

// LockOrderByNo 在调用方事务里锁定订单行（FOR UPDATE）。订单号不区分大小写；不存在返回 ORDER_NOT_FOUND。
func (s *Service) LockOrderByNo(ctx context.Context, tx pgx.Tx, orderNo string) (Order, error) {
	row, err := store.New(tx).LockRegOrderByNo(ctx, strings.ToUpper(strings.TrimSpace(orderNo)))
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return Order{}, fmt.Errorf("lock order %q: %w", orderNo, err)
	}
	return orderFromLockedRow(row), nil
}

// LockOrderByID 在调用方事务里按主键锁定订单行（FOR UPDATE）；不存在返回 ORDER_NOT_FOUND。
func (s *Service) LockOrderByID(ctx context.Context, tx pgx.Tx, id int64) (Order, error) {
	row, err := store.New(tx).LockRegOrderByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return Order{}, fmt.Errorf("lock order %d: %w", id, err)
	}
	return orderFromLockedRow(row), nil
}

// MarkProofSubmitted 把待付款或被驳回的订单改为审核中并清空截止时间；状态不符返回 ORDER_STATE_CONFLICT。
func (s *Service) MarkProofSubmitted(ctx context.Context, tx pgx.Tx, orderID int64) error {
	n, err := store.New(tx).SetOrderProofSubmitted(ctx, orderID)
	if err != nil {
		return fmt.Errorf("mark order %d proof submitted: %w", orderID, err)
	}
	if n != 1 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return nil
}

// MarkProofRejected 把审核中的订单改为被驳回，并设置重传截止时间；状态不符返回 ORDER_STATE_CONFLICT。
func (s *Service) MarkProofRejected(ctx context.Context, tx pgx.Tx, orderID int64, deadline time.Time) error {
	n, err := store.New(tx).SetOrderProofRejected(ctx, store.SetOrderProofRejectedParams{ID: orderID, DeadlineAt: deadline.UTC()})
	if err != nil {
		return fmt.Errorf("mark order %d proof rejected: %w", orderID, err)
	}
	if n != 1 {
		return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
	}
	return nil
}

func orderFromLockedRow(r store.RegOrder) Order {
	o := Order{
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
	}
	if r.BuyerUserID != nil {
		o.BuyerUserID = *r.BuyerUserID
	}
	if r.PaymentAccountID != nil {
		o.PaymentAccountID = *r.PaymentAccountID
	}
	return o
}
