package registration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/idgen"
)

// idgen.Retry 包住的插入必须在保存点里执行：唯一约束冲突只回滚保存点，外层事务继续可用，重试成功后一起提交。
func TestWithSavepointKeepsOuterTransactionUsableForRetry(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	const insert = `INSERT INTO idempotency_keys (key, scope, subject, request_hash, created_at, expires_at)
		VALUES ($1, 'savepoint.test', 'user:1', '\x00'::bytea, $2, $3)`

	attempts := 0
	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, insert, "taken-key", now, now.Add(time.Hour)); err != nil {
			return err
		}
		return idgen.Retry("idempotency_keys_pkey", func() error {
			return withSavepoint(ctx, tx, func(sp pgx.Tx) error {
				attempts++
				key := "taken-key" // 第一次必然冲突
				if attempts > 1 {
					key = "fresh-key"
				}
				_, err := sp.Exec(ctx, insert, key, now, now.Add(time.Hour))
				return err
			})
		})
	})

	require.NoError(t, err)
	require.Equal(t, 2, attempts)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_keys WHERE scope = 'savepoint.test'`).Scan(&n))
	require.Equal(t, 2, n, "冲突前后的插入都随外层事务提交")

	t.Run("非重试错误原样返回且外层事务仍可继续", func(t *testing.T) {
		err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
			spErr := withSavepoint(ctx, tx, func(sp pgx.Tx) error {
				_, err := sp.Exec(ctx, insert, "taken-key", now, now.Add(time.Hour))
				return err
			})
			var pgErr *pgconn.PgError
			require.True(t, errors.As(spErr, &pgErr))
			require.Equal(t, "23505", pgErr.Code)
			_, err := tx.Exec(ctx, insert, "after-failure", now, now.Add(time.Hour))
			return err
		})
		require.NoError(t, err)
	})
}
