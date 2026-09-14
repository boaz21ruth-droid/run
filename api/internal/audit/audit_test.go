package audit

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
)

func TestRecordInsertsRow(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	staffID := int64(42)
	role := "OPS"

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		return Record(ctx, tx, Entry{
			ActorType:  "STAFF",
			ActorID:    &staffID,
			ActorRole:  &role,
			Action:     "event.create",
			EntityType: "event",
			EntityID:   7,
			Summary:    "创建赛事 pphm-2026",
			After:      map[string]string{"slug": "pphm-2026"},
			Meta:       httpx.Meta{RequestID: "req-1", IP: "203.0.113.7", UserAgent: "go-test"},
		})
	})
	require.NoError(t, err)

	var (
		action, actorType, actorRole, requestID, ip, userAgent string
		actorID, entityID                                      int64
		after                                                  []byte
		before                                                 *string
	)
	err = pool.QueryRow(ctx, `
		SELECT action, actor_type, actor_id, actor_role, entity_id, after_data, before_data::text,
		       request_id, host(ip), user_agent
		FROM audit_logs`).
		Scan(&action, &actorType, &actorID, &actorRole, &entityID, &after, &before, &requestID, &ip, &userAgent)
	require.NoError(t, err)

	assert.Equal(t, "event.create", action)
	assert.Equal(t, "STAFF", actorType)
	assert.Equal(t, int64(42), actorID)
	assert.Equal(t, "OPS", actorRole)
	assert.Equal(t, int64(7), entityID)
	assert.JSONEq(t, `{"slug":"pphm-2026"}`, string(after))
	assert.Nil(t, before)
	assert.Equal(t, "req-1", requestID)
	assert.Equal(t, "203.0.113.7", ip)
	assert.Equal(t, "go-test", userAgent)
}

func TestRecordRollsBackWithTransaction(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	boom := errors.New("business failure")

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if err := Record(ctx, tx, Entry{
			ActorType:  "SYSTEM",
			Action:     "event.publish",
			EntityType: "event",
			EntityID:   1,
			Summary:    "发布赛事",
		}); err != nil {
			return err
		}
		return boom
	})
	require.ErrorIs(t, err, boom)

	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs`).Scan(&n))
	assert.Equal(t, 0, n)
}

func TestRecordWithoutOptionalFields(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		return Record(ctx, tx, Entry{
			ActorType:  "SYSTEM",
			Action:     "staff.login_failed",
			EntityType: "staff",
			EntityID:   3,
			Summary:    "员工 ops.chan 登录失败：密码错误",
			Meta:       httpx.Meta{IP: "not-an-ip"},
		})
	})
	require.NoError(t, err)

	var actorID *int64
	var ip, requestID *string
	require.NoError(t, pool.QueryRow(ctx, `SELECT actor_id, host(ip), request_id FROM audit_logs`).Scan(&actorID, &ip, &requestID))
	assert.Nil(t, actorID)
	assert.Nil(t, ip)
	assert.Nil(t, requestID)
}
