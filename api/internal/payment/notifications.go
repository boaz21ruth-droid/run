package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/notify"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/i18n"
)

// proofNotice 是审核结果推送需要的订单信息。必须在审核事务里、订单状态更新之后读取，
// 驳回时读到的 deadline_at 才是新的重传截止时间。只读不加锁，不改变审核流程的加锁顺序。
type proofNotice struct {
	OrderNo       string
	BuyerUserID   *int64
	DeadlineAt    *time.Time
	EventName     i18n.Text
	EventTimezone string
}

func loadProofNotice(ctx context.Context, tx pgx.Tx, orderID int64) (proofNotice, error) {
	row, err := store.New(tx).GetOrderForProofNotice(ctx, orderID)
	if err != nil {
		return proofNotice{}, fmt.Errorf("load order %d for notification: %w", orderID, err)
	}
	var name i18n.Text
	if err := json.Unmarshal(row.EventName, &name); err != nil {
		return proofNotice{}, fmt.Errorf("decode event name for order %d: %w", orderID, err)
	}
	return proofNotice{
		OrderNo:       row.OrderNo,
		BuyerUserID:   row.BuyerUserID,
		DeadlineAt:    row.DeadlineAt,
		EventName:     name,
		EventTimezone: row.EventTimezone,
	}, nil
}

// enqueueProofApproved 在审核通过事务内登记 proof_approved 推送。
func (s *Service) enqueueProofApproved(ctx context.Context, tx pgx.Tx, orderID, proofID int64) error {
	info, err := loadProofNotice(ctx, tx, orderID)
	if err != nil {
		return err
	}
	if info.BuyerUserID == nil {
		return nil
	}
	return s.notifier.Enqueue(ctx, tx, notify.Notification{
		Template: notify.TemplateProofApproved,
		UserID:   *info.BuyerUserID,
		OrderID:  orderID,
		ProofID:  &proofID,
		Params: map[string]any{
			"orderNo":   info.OrderNo,
			"eventName": info.EventName,
		},
	})
}

// enqueueProofRejected 在驳回事务内（MarkProofRejected 之后）登记 proof_rejected 推送。
func (s *Service) enqueueProofRejected(ctx context.Context, tx pgx.Tx, orderID, proofID int64, in RejectInput) error {
	info, err := loadProofNotice(ctx, tx, orderID)
	if err != nil {
		return err
	}
	if info.BuyerUserID == nil {
		return nil
	}
	deadline := ""
	if info.DeadlineAt != nil {
		deadline = notify.FormatTime(*info.DeadlineAt, info.EventTimezone)
	}
	return s.notifier.Enqueue(ctx, tx, notify.Notification{
		Template: notify.TemplateProofRejected,
		UserID:   *info.BuyerUserID,
		OrderID:  orderID,
		ProofID:  &proofID,
		Params: map[string]any{
			"orderNo":   info.OrderNo,
			"eventName": info.EventName,
			"reason":    notify.RejectReason{Code: in.Code, Note: in.Reason},
			"deadline":  deadline,
		},
	})
}
