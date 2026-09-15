package notify_test

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/notify"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
)

const expiredTextEN = "Order WR0000TEST was not paid in time and has been cancelled. Your spot has been released. Please register again if you still want to take part."

func insertTelegramUser(t *testing.T, pool *pgxpool.Pool, telegramID int64, locale string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO users (telegram_user_id, display_name, locale) VALUES ($1, 'Runner', $2) RETURNING id`,
		telegramID, locale).Scan(&id))
	return id
}

func countNotifyRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func enqueueInTx(t *testing.T, pool *pgxpool.Pool, svc *notify.Service, n notify.Notification) {
	t.Helper()
	require.NoError(t, db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		return svc.Enqueue(context.Background(), tx, n)
	}))
}

func TestEnqueueWritesLogAndSendJob(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555001, "en")
	ctx := context.Background()

	enqueueInTx(t, pool, svc, notify.Notification{
		Template: notify.TemplateOrderExpired,
		UserID:   userID,
		OrderID:  77,
		Params:   map[string]any{"orderNo": "WR0000TEST"},
	})

	var (
		logID                                                         int64
		channel, recipient, template, locale, entityType, key, status string
		entityID                                                      int64
		attempts                                                      int16
	)
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT id, channel, recipient, template, locale, entity_type, entity_id, dedupe_key, status, attempts
		FROM notification_logs`).Scan(&logID, &channel, &recipient, &template, &locale, &entityType, &entityID, &key, &status, &attempts))
	require.Equal(t, "TELEGRAM", channel)
	require.Equal(t, "555001", recipient)
	require.Equal(t, "order_expired", template)
	require.Equal(t, "en", locale)
	require.Equal(t, "reg_order", entityType)
	require.Equal(t, int64(77), entityID)
	require.Equal(t, "order_expired:77:0", key)
	require.Equal(t, "PENDING", status)
	require.Equal(t, int16(0), attempts)

	var (
		kind        string
		maxAttempts int
		args        []byte
	)
	require.NoError(t, pool.QueryRow(ctx, `SELECT kind, max_attempts, args FROM river_job`).Scan(&kind, &maxAttempts, &args))
	require.Equal(t, "notify_send", kind)
	require.Equal(t, 5, maxAttempts)
	require.JSONEq(t, `{
		"log_id": `+strconv.FormatInt(logID, 10)+`,
		"chat_id": 555001,
		"text": "`+expiredTextEN+`",
		"button": {"text": "View order", "url": "https://app.werun.test/orders/WR0000TEST"}
	}`, string(args))
}

func TestEnqueueSameDedupeKeyTwiceInsertsOnce(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555002, "zh")
	proofID := int64(9)
	n := notify.Notification{
		Template: notify.TemplateProofApproved,
		UserID:   userID,
		OrderID:  77,
		ProofID:  &proofID,
		Params: map[string]any{
			"orderNo":   "WR0000TEST",
			"eventName": i18n.Text{i18n.ZH: "金边城市跑", i18n.EN: "Phnom Penh City Run"},
		},
	}

	enqueueInTx(t, pool, svc, n)
	enqueueInTx(t, pool, svc, n)

	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE dedupe_key = 'proof_approved:77:9'`))
	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 1, countNotifyRows(t, pool,
		`SELECT count(*) FROM river_job WHERE args->>'text' = $1`,
		"付款已确认\n赛事：金边城市跑\n订单号：WR0000TEST\n报名已生效，打开订单即可查看参赛凭证。"))
}

func TestEnqueueHonorsExplicitDedupeKey(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555003, "en")
	reminder := func(key string) notify.Notification {
		return notify.Notification{
			Template:  notify.TemplateDeadlineReminder,
			UserID:    userID,
			OrderID:   77,
			DedupeKey: key,
			Params:    map[string]any{"orderNo": "WR0000TEST", "deadline": "2026-09-15 10:00"},
		}
	}

	enqueueInTx(t, pool, svc, reminder("reminder:77:1789441200"))
	enqueueInTx(t, pool, svc, reminder("reminder:77:1789441200"))
	enqueueInTx(t, pool, svc, reminder("reminder:77:1789527600"))

	require.Equal(t, 2, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE template = 'payment_deadline_reminder'`))
	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE dedupe_key = 'reminder:77:1789441200'`))
	require.Equal(t, 2, countNotifyRows(t, pool, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
}

func TestEnqueueSkipsUserWithoutTelegram(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	var userID int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO users (phone_e164, locale) VALUES ('+85510000001', 'en') RETURNING id`).Scan(&userID))

	enqueueInTx(t, pool, svc, notify.Notification{
		Template: notify.TemplateOrderExpired,
		UserID:   userID,
		OrderID:  77,
		Params:   map[string]any{"orderNo": "WR0000TEST"},
	})

	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM river_job`))
}

func TestEnqueueRollsBackWithCallerTransaction(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555004, "en")
	boom := errors.New("boom")

	err := db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		if err := svc.Enqueue(context.Background(), tx, notify.Notification{
			Template: notify.TemplateOrderExpired, UserID: userID, OrderID: 77,
			Params: map[string]any{"orderNo": "WR0000TEST"},
		}); err != nil {
			return err
		}
		return boom
	})

	require.ErrorIs(t, err, boom)
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM river_job`))
}

func TestEnqueueUsesRecipientLocaleForButton(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555005, "km")

	enqueueInTx(t, pool, svc, notify.Notification{
		Template: notify.TemplateOrderExpired, UserID: userID, OrderID: 78,
		Params: map[string]any{"orderNo": "WR0000KM01"},
	})

	require.Equal(t, 1, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs WHERE locale = 'km'`))
	require.Equal(t, 1, countNotifyRows(t, pool,
		`SELECT count(*) FROM river_job WHERE args->'button'->>'text' = 'មើលការបញ្ជាទិញ'`))
}

func TestEnqueueRequiresOrderNo(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := notifytest.New(t, pool)
	userID := insertTelegramUser(t, pool, 555006, "en")

	err := db.InTx(context.Background(), pool, func(tx pgx.Tx) error {
		return svc.Enqueue(context.Background(), tx, notify.Notification{
			Template: notify.TemplateOrderExpired, UserID: userID, OrderID: 79,
		})
	})

	require.ErrorContains(t, err, "orderNo")
	require.Equal(t, 0, countNotifyRows(t, pool, `SELECT count(*) FROM notification_logs`))
}
