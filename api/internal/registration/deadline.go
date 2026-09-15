package registration

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"werun/api/internal/audit"
	"werun/api/internal/notify"
	"werun/api/internal/platform/db"
	"werun/api/internal/registration/store"
)

const (
	deadlineBatchSize = 100
	reminderWindow    = 10 * time.Minute
	// idempotencyPurgeBatch 是每次运行至多删除的过期幂等键数（每分钟一次，足够跟上增长）。
	idempotencyPurgeBatch = 1000
)

// DeadlineArgs 是 order_deadline 周期任务的参数（无字段）。
type DeadlineArgs struct{}

// Kind 是 River 任务类型名。
func (DeadlineArgs) Kind() string { return "order_deadline" }

// DeadlineWorker 每分钟执行一次超时释放与付款提醒，并顺带清理过期的幂等键。
type DeadlineWorker struct {
	river.WorkerDefaults[DeadlineArgs]
	Svc *Service
	Log *slog.Logger
}

// Work 调用 ProcessDeadlines 与 PurgeExpiredIdempotencyKeys 并记录处理数量；出错时返回错误由 River 重试（两者都可重复执行）。
func (w *DeadlineWorker) Work(ctx context.Context, job *river.Job[DeadlineArgs]) error {
	expired, reminded, err := w.Svc.ProcessDeadlines(ctx)
	if err != nil {
		return fmt.Errorf("process order deadlines: %w", err)
	}
	purged, err := w.Svc.PurgeExpiredIdempotencyKeys(ctx)
	if err != nil {
		return fmt.Errorf("purge expired idempotency keys: %w", err)
	}
	w.Log.InfoContext(ctx, "order deadline job finished",
		"job_id", job.ID, "expired", expired, "reminded", reminded, "idempotency_keys_purged", purged)
	return nil
}

// ProcessDeadlines 释放已过截止时间的待付款 / 被驳回订单（每批 100 条、一批一个事务，直到不足一批），
// 然后为截止前 10 分钟内的订单登记付款提醒。返回本次释放的订单数与新入队的提醒数。
func (s *Service) ProcessDeadlines(ctx context.Context) (expired, reminded int, err error) {
	asOf := s.now()
	for {
		selected, released, batchErr := s.expireDueBatch(ctx, asOf)
		if batchErr != nil {
			return expired, 0, fmt.Errorf("expire due orders: %w", batchErr)
		}
		expired += released
		// 不足一批说明已处理完；整批都没有释放成功时也停下，避免同一批订单反复被选中而空转。
		if selected < deadlineBatchSize || released == 0 {
			break
		}
	}

	reminded, err = s.enqueueDeadlineReminders(ctx, asOf)
	if err != nil {
		return expired, 0, fmt.Errorf("enqueue deadline reminders: %w", err)
	}
	return expired, reminded, nil
}

// expireDueBatch 在一个事务里锁定至多 100 张到期订单并逐张释放。
// 只锁订单行，随后按 组别 → 价格档 → 优惠码 升序一次锁住本批计数行；不锁凭证行（审核流程的加锁顺序是凭证 → 订单 → 计数）。
func (s *Service) expireDueBatch(ctx context.Context, asOf time.Time) (int, int, error) {
	var selected, released int
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		selected, released = 0, 0
		ids, err := store.New(tx).ListDueOrderIDsForExpiry(ctx, store.ListDueOrderIDsForExpiryParams{
			AsOf:       asOf,
			BatchLimit: deadlineBatchSize,
		})
		if err != nil {
			return fmt.Errorf("lock due orders: %w", err)
		}
		selected = len(ids)
		if selected == 0 {
			return nil
		}
		// 先按全局顺序锁住本批全部计数行，再逐张释放；否则多张订单依次加锁会与 CreateOrder 等形成死锁。
		if err := s.prices.LockCountersForOrders(ctx, tx, ids); err != nil {
			return err
		}
		for _, id := range ids {
			ok, err := s.expireOrder(ctx, tx, id)
			if err != nil {
				return err
			}
			if ok {
				released++
			}
		}
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return selected, released, nil
}

// expireOrder 释放一张已被本事务锁定的订单；条件更新没有命中（已被释放或状态已变）时返回 false。
func (s *Service) expireOrder(ctx context.Context, tx pgx.Tx, orderID int64) (bool, error) {
	before, err := store.New(tx).GetOrderForExpiryNotice(ctx, orderID)
	if err != nil {
		return false, fmt.Errorf("load order %d: %w", orderID, err)
	}
	released, err := s.ReleaseOrder(ctx, tx, orderID, ReleaseExpired)
	if err != nil {
		return false, fmt.Errorf("release order %d: %w", orderID, err)
	}
	if !released {
		return false, nil
	}

	eventID := before.EventID
	if err := audit.Record(ctx, tx, audit.Entry{
		ActorType:   "SYSTEM",
		Action:      "reg_order.expire",
		EntityType:  "reg_order",
		EntityID:    orderID,
		EventID:     &eventID,
		IsFinancial: true,
		Summary:     fmt.Sprintf("订单 %s 超过付款期限，已释放名额", before.OrderNo),
		Before: map[string]any{
			"status":           before.Status,
			"reservationState": "RESERVED",
			"deadlineAt":       before.DeadlineAt,
		},
		After: map[string]any{
			"status":           StatusExpired,
			"reservationState": "RELEASED",
			"releaseKind":      string(ReleaseExpired),
		},
	}); err != nil {
		return false, err
	}

	if before.BuyerUserID == nil {
		return true, nil
	}
	if err := s.notifier.Enqueue(ctx, tx, notify.Notification{
		Template: notify.TemplateOrderExpired,
		UserID:   *before.BuyerUserID,
		OrderID:  orderID,
		Params:   map[string]any{"orderNo": before.OrderNo},
	}); err != nil {
		return false, fmt.Errorf("enqueue expiry notice for order %d: %w", orderID, err)
	}
	return true, nil
}

// enqueueDeadlineReminders 为截止时间落在 (asOf, asOf+10 分钟] 的订单登记提醒，每个截止时间只提醒一次。
func (s *Service) enqueueDeadlineReminders(ctx context.Context, asOf time.Time) (int, error) {
	var sent int
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		sent = 0
		rows, err := store.New(tx).ListOrdersDueForReminder(ctx, store.ListOrdersDueForReminderParams{
			AsOf:  asOf,
			Until: asOf.Add(reminderWindow),
		})
		if err != nil {
			return fmt.Errorf("list orders near deadline: %w", err)
		}
		for _, r := range rows {
			if r.BuyerUserID == nil || r.DeadlineAt == nil {
				continue
			}
			deadline := *r.DeadlineAt
			if err := s.notifier.Enqueue(ctx, tx, notify.Notification{
				Template:  notify.TemplateDeadlineReminder,
				UserID:    *r.BuyerUserID,
				OrderID:   r.ID,
				DedupeKey: reminderDedupeKey(r.ID, deadline),
				Params: map[string]any{
					"orderNo":  r.OrderNo,
					"deadline": notify.FormatTime(deadline, r.EventTimezone),
				},
			}); err != nil {
				return fmt.Errorf("enqueue reminder for order %d: %w", r.ID, err)
			}
			sent++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return sent, nil
}

// reminderDedupeKey 与 ListOrdersDueForReminder 里的 SQL 表达式必须一致。
func reminderDedupeKey(orderID int64, deadline time.Time) string {
	return fmt.Sprintf("reminder:%d:%d", orderID, deadline.Unix())
}

// PurgeExpiredIdempotencyKeys 删除至多一批 expires_at 早于当前时间的幂等键（spec：键保留 24 小时），返回删除条数。
// 未过期的键不动；已过期但尚未删除的键仍会被 ClaimIdempotencyKey 覆盖，所以晚几分钟删除不影响正确性。
func (s *Service) PurgeExpiredIdempotencyKeys(ctx context.Context) (int64, error) {
	n, err := store.New(s.pool).PurgeExpiredIdempotencyKeys(ctx, store.PurgeExpiredIdempotencyKeysParams{
		Now:        s.now(),
		BatchLimit: idempotencyPurgeBatch,
	})
	if err != nil {
		return 0, fmt.Errorf("delete expired idempotency keys: %w", err)
	}
	return n, nil
}
