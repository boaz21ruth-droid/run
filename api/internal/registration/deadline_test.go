package registration_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/require"

	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/logx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
	"werun/api/internal/registration/regtest"
)

func expiredNoticeText(orderNo string) string {
	return fmt.Sprintf("Order %s was not paid in time and has been cancelled. Your spot has been released. Please register again if you still want to take part.", orderNo)
}

func reminderNoticeText(t *testing.T, orderNo string, deadline time.Time) string {
	t.Helper()
	loc, err := time.LoadLocation(regtest.EventTimezone)
	require.NoError(t, err)
	return fmt.Sprintf("Order %s: payment is due by %s. Please complete the transfer and upload your payment proof, otherwise your spot will be released.",
		orderNo, deadline.In(loc).Format("2006-01-02 15:04"))
}

func TestDeadlineArgsKind(t *testing.T) {
	require.Equal(t, "order_deadline", registration.DeadlineArgs{}.Kind())
}

func TestProcessDeadlinesExpiresPendingPaymentOrder(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810001, "en")
	order := env.CreateOrder(t, user, "E8100011", regtest.CouponCode)
	require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1, CouponReserved: 1}, env.Counters(t))

	env.Clock.Advance(31 * time.Minute)
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 1, expired)
	require.Equal(t, 0, reminded)
	require.Equal(t, 1, env.CountRows(t, `
		SELECT count(*) FROM reg_orders
		WHERE id = $1 AND status = 'EXPIRED' AND reservation_state = 'RELEASED'
		  AND reservation_release_kind = 'ORDER_EXPIRED' AND deadline_at IS NULL AND expired_at IS NOT NULL`, order.ID))
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'RELEASED'`, order.ID))
	require.Equal(t, 1, env.CountRows(t, `
		SELECT count(*) FROM registrations r JOIN order_participants p ON p.id = r.order_participant_id
		WHERE p.order_id = $1 AND r.status = 'CANCELLED' AND r.cancel_reason = 'ORDER_EXPIRED'`, order.ID))
	require.Equal(t, 0, env.CountRows(t, `
		SELECT count(*) FROM registrations r JOIN order_participants p ON p.id = r.order_participant_id
		WHERE p.order_id = $1 AND r.status <> 'CANCELLED'`, order.ID))
	require.Equal(t, 1, env.CountRows(t, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'reg_order.expire' AND entity_type = 'reg_order' AND entity_id = $1
		  AND actor_type = 'SYSTEM' AND actor_id IS NULL AND is_financial`, order.ID))
	require.Equal(t, 1, env.CountRows(t,
		`SELECT count(*) FROM notification_logs WHERE template = 'order_expired' AND dedupe_key = $1`,
		fmt.Sprintf("order_expired:%d:0", order.ID)))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, expiredNoticeText(order.OrderNo),
		env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))
}

func TestProcessDeadlinesExpiresRejectedOrderAfterReuploadDeadline(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810002, "en"), "E8100021", "")
	reupload := env.Clock.Now().Add(24 * time.Hour)
	env.Exec(t, `UPDATE reg_orders SET status = 'PROOF_REJECTED', deadline_at = $2 WHERE id = $1`, order.ID, reupload)

	env.Clock.Set(reupload.Add(-11 * time.Minute))
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, expired, "重传期未到不能释放")
	require.Equal(t, 0, reminded, "距截止 11 分钟不在提醒窗口内")

	env.Clock.Set(reupload)
	expired, _, err = env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 1, expired)
	require.Equal(t, "EXPIRED", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID))
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
}

func TestProcessDeadlinesLeavesProofSubmittedOrderAlone(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810003, "en"), "E8100031", "")
	// 故意保留一个已过去的 deadline_at：只按状态过滤也不能动审核中的订单。
	env.Exec(t, `UPDATE reg_orders SET status = 'PROOF_SUBMITTED', deadline_at = $2 WHERE id = $1`, order.ID, env.Clock.Now().Add(-time.Minute))

	env.Clock.Advance(31 * time.Minute)
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 0, expired)
	require.Equal(t, 0, reminded)
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED' AND reservation_state = 'RESERVED'`, order.ID))
	require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1}, env.Counters(t))
	require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
	require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM notification_logs`))
}

func TestProcessDeadlinesTwiceReleasesOnce(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810004, "en")
	env.CreateOrder(t, user, "E8100041", regtest.CouponCode)
	env.CreateOrder(t, user, "E8100042", "")
	require.Equal(t, regtest.Counters{CategoryReserved: 2, RuleReserved: 2, CouponReserved: 1}, env.Counters(t))

	env.Clock.Advance(31 * time.Minute)
	expired, _, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, expired)

	expired, _, err = env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 0, expired)
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
}

// 同一组别、同一价格档上另有一张未到期订单持有预留：重复运行只释放到期订单一次，另一张的预留原样保留。
func TestProcessDeadlinesReleasesOnlyOverdueOrderAndKeepsOtherReservations(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810010, "en")
	overdue := env.CreateOrder(t, user, "E8100101", regtest.CouponCode)
	env.Clock.Advance(20 * time.Minute)
	other := env.CreateOrder(t, user, "E8100102", "")
	require.Equal(t, regtest.Counters{CategoryReserved: 2, RuleReserved: 2, CouponReserved: 1}, env.Counters(t))

	// 到期订单已过截止 1 分钟；另一张距截止还有 19 分钟（不在提醒窗口内）。
	env.Clock.Advance(11 * time.Minute)
	for run := 1; run <= 2; run++ {
		expired, reminded, err := env.Orders.ProcessDeadlines(ctx)
		require.NoError(t, err)
		require.Equalf(t, 2-run, expired, "第 %d 次运行", run)
		require.Equal(t, 0, reminded)

		require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1}, env.Counters(t))
		require.Equal(t, "EXPIRED", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, overdue.ID))
		require.Equal(t, 1, env.CountRows(t, `
			SELECT count(*) FROM reg_orders
			WHERE id = $1 AND status = 'PENDING_PAYMENT' AND reservation_state = 'RESERVED' AND deadline_at IS NOT NULL`, other.ID))
		require.Equal(t, 0, env.CountRows(t, `
			SELECT count(*) FROM registrations r JOIN order_participants p ON p.id = r.order_participant_id
			WHERE p.order_id = $1 AND r.status = 'CANCELLED'`, other.ID))
		require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
		require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire' AND entity_id = $1`, overdue.ID))
		require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs`))
		require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	}
}

func TestProcessDeadlinesProcessesMultipleBatches(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810005, "en")
	const total = 150
	for i := range total {
		env.CreateOrder(t, user, fmt.Sprintf("B%07d", i), "")
	}
	require.Equal(t, total, env.Counters(t).CategoryReserved)

	env.Clock.Advance(31 * time.Minute)
	expired, _, err := env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, total, expired)
	require.Equal(t, total, env.CountRows(t, `SELECT count(*) FROM reg_orders WHERE status = 'EXPIRED'`))
	require.Equal(t, regtest.Counters{}, env.Counters(t))
	require.Equal(t, total, env.CountRows(t, `SELECT count(*) FROM audit_logs WHERE action = 'reg_order.expire'`))
	require.Equal(t, total, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
}

func TestProcessDeadlinesSkipsOrderLockedByAnotherTransaction(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810006, "en"), "E8100061", "")
	env.Clock.Advance(31 * time.Minute)

	// 模拟上传凭证事务正持有订单行锁。
	tx, err := env.Pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	var lockedID int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT id FROM reg_orders WHERE id = $1 FOR UPDATE`, order.ID).Scan(&lockedID))

	expired, _, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, expired, "SKIP LOCKED 必须跳过被锁住的订单")
	require.Equal(t, "PENDING_PAYMENT", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID))

	require.NoError(t, tx.Rollback(ctx))
	expired, _, err = env.Orders.ProcessDeadlines(ctx)

	require.NoError(t, err)
	require.Equal(t, 1, expired)
	require.Equal(t, regtest.Counters{}, env.Counters(t))
}

// 并发：同一订单的上传凭证与超时释放同时发生，只能有一边生效。本机用 -count=5 连续运行确认稳定。
func TestProcessDeadlinesRacesSubmitProof(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	user := env.NewRunner(t, 810007, "en")
	order := env.CreateOrder(t, user, "E8100071", "")
	require.NotNil(t, order.DeadlineAt)
	deadline := *order.DeadlineAt
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	// 付款服务的时钟停在截止前 1 分钟（上传本身合法），超时任务的时钟已过截止时间。
	pay := payment.NewService(env.Pool, disk, env.Orders, env.Notifier, func() time.Time { return deadline.Add(-time.Minute) })
	env.Clock.Set(deadline.Add(time.Second))
	img := regtest.PNG(t)

	var (
		wg         sync.WaitGroup
		submitErr  error
		processErr error
		expired    int
	)
	start := make(chan struct{})
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, submitErr = pay.SubmitProof(ctx, user, order.OrderNo, payment.SubmitProofInput{
			File:                bytes.NewReader(img),
			BankTxnRef:          "RACE8100071",
			DeclaredAmountCents: order.AmountCents,
		}, httpx.Meta{})
	}()
	go func() {
		defer wg.Done()
		<-start
		expired, _, processErr = env.Orders.ProcessDeadlines(ctx)
	}()
	close(start)
	wg.Wait()

	require.NoError(t, processErr)
	status := env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID)
	proofs := env.CountRows(t, `SELECT count(*) FROM payment_proofs WHERE reg_order_id = $1`, order.ID)
	counters := env.Counters(t)
	if submitErr == nil {
		require.Equal(t, 0, expired)
		require.Equal(t, "PROOF_SUBMITTED", status)
		require.Equal(t, 1, proofs)
		require.Equal(t, regtest.Counters{CategoryReserved: 1, RuleReserved: 1}, counters)
		require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM notification_logs`))
		return
	}
	ae, ok := apperr.As(submitErr)
	require.Truef(t, ok, "上传失败必须是业务错误，得到 %v", submitErr)
	require.Contains(t, []string{apperr.CodeOrderStateConflict, apperr.CodeOrderExpired}, ae.Code)
	require.Equal(t, 1, expired)
	require.Equal(t, "EXPIRED", status)
	require.Equal(t, 0, proofs)
	require.Equal(t, regtest.Counters{}, counters)
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'order_expired'`))
}

func TestProcessDeadlinesRemindsOncePerDeadline(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	order := env.CreateOrder(t, env.NewRunner(t, 810008, "en"), "E8100081", "")
	require.NotNil(t, order.DeadlineAt)
	first := *order.DeadlineAt

	env.Clock.Set(first.Add(-9 * time.Minute))
	expired, reminded, err := env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, expired)
	require.Equal(t, 1, reminded)

	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, reminded, "同一截止时间只提醒一次")
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'payment_deadline_reminder'`))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE dedupe_key = $1`,
		fmt.Sprintf("reminder:%d:%d", order.ID, first.Unix())))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, reminderNoticeText(t, order.OrderNo, first),
		env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))

	// 驳回后进入 24 小时重传期：新的截止时间再提醒一次。
	second := env.Clock.Now().Add(24 * time.Hour)
	env.Exec(t, `UPDATE reg_orders SET status = 'PROOF_REJECTED', deadline_at = $2 WHERE id = $1`, order.ID, second)
	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, reminded)

	env.Clock.Set(second.Add(-5 * time.Minute))
	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, reminded)
	_, reminded, err = env.Orders.ProcessDeadlines(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, reminded)

	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE template = 'payment_deadline_reminder'`))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM notification_logs WHERE dedupe_key = $1`,
		fmt.Sprintf("reminder:%d:%d", order.ID, second.Unix())))
	require.Equal(t, 2, env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
}

func TestDeadlineWorkerProcessesDueOrders(t *testing.T) {
	env := regtest.New(t)
	order := env.CreateOrder(t, env.NewRunner(t, 810009, "en"), "E8100091", "")
	env.Clock.Advance(31 * time.Minute)
	worker := &registration.DeadlineWorker{Svc: env.Orders, Log: logx.New("error", io.Discard)}

	err := worker.Work(context.Background(), &river.Job[registration.DeadlineArgs]{JobRow: &rivertype.JobRow{ID: 9}})

	require.NoError(t, err)
	require.Equal(t, "EXPIRED", env.QueryString(t, `SELECT status FROM reg_orders WHERE id = $1`, order.ID))
}

// 幂等键保留 24 小时（spec）：order_deadline 每次运行顺带删除已过期的键，未过期的键保留。
func TestDeadlineWorkerPurgesExpiredIdempotencyKeys(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	// CreateOrder 写入一条 24 小时有效的幂等键。
	env.CreateOrder(t, env.NewRunner(t, 810011, "en"), "E8100111", "")
	now := env.Clock.Now()
	insertKey := func(key string, expiresAt time.Time) {
		env.Exec(t, `
			INSERT INTO idempotency_keys (key, scope, subject, request_hash, created_at, expires_at)
			VALUES ($1, 'reg_order.create', 'user:purge-test', '\x00'::bytea, $2, $3)`,
			key, expiresAt.Add(-24*time.Hour), expiresAt)
	}
	insertKey("expired-long-ago", now.Add(-48*time.Hour))
	insertKey("expired-just-now", now.Add(-time.Second))
	insertKey("still-valid", now.Add(time.Minute))
	require.Equal(t, 4, env.CountRows(t, `SELECT count(*) FROM idempotency_keys`))
	worker := &registration.DeadlineWorker{Svc: env.Orders, Log: logx.New("error", io.Discard)}

	require.NoError(t, worker.Work(ctx, &river.Job[registration.DeadlineArgs]{JobRow: &rivertype.JobRow{ID: 10}}))

	require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM idempotency_keys WHERE key LIKE 'expired-%'`))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM idempotency_keys WHERE key = 'still-valid'`))
	require.Equal(t, 1, env.CountRows(t, `SELECT count(*) FROM idempotency_keys WHERE key = 'regtest-E8100111'`))
}

func TestPurgeExpiredIdempotencyKeysDeletesBoundedBatch(t *testing.T) {
	env := regtest.New(t)
	ctx := context.Background()
	const batch = 1000 // 与 registration.idempotencyPurgeBatch 一致
	env.Exec(t, `
		INSERT INTO idempotency_keys (key, scope, subject, request_hash, created_at, expires_at)
		SELECT 'k' || g, 'reg_order.create', 'user:batch-test', '\x00'::bytea, $1::timestamptz - interval '1 day', $1
		FROM generate_series(1, $2::int) g`, env.Clock.Now().Add(-time.Hour), batch+5)

	deleted, err := env.Orders.PurgeExpiredIdempotencyKeys(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(batch), deleted)
	require.Equal(t, 5, env.CountRows(t, `SELECT count(*) FROM idempotency_keys`))

	deleted, err = env.Orders.PurgeExpiredIdempotencyKeys(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(5), deleted)
	require.Equal(t, 0, env.CountRows(t, `SELECT count(*) FROM idempotency_keys`))
}
