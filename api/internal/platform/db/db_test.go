package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
)

func countSetting(t *testing.T, pool *pgxpool.Pool, key string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM system_settings WHERE key = $1`, key).Scan(&n))
	return n
}

func insertSetting(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `INSERT INTO system_settings (key, value) VALUES ($1, '1')`, key)
	return err
}

func TestOpenFailsForUnreachableDatabase(t *testing.T) {
	_, err := db.Open(context.Background(), "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1&sslmode=disable")

	assert.Error(t, err)
}

func TestInTxCommits(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		return insertSetting(ctx, tx, "test.commit")
	})

	require.NoError(t, err)
	assert.Equal(t, 1, countSetting(t, pool, "test.commit"))
}

func TestInTxRollsBackOnError(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	stop := errors.New("stop")

	err := db.InTx(ctx, pool, func(tx pgx.Tx) error {
		if err := insertSetting(ctx, tx, "test.error"); err != nil {
			return err
		}
		return stop
	})

	assert.ErrorIs(t, err, stop)
	assert.Equal(t, 0, countSetting(t, pool, "test.error"))
}

func TestInTxRollsBackOnPanic(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	assert.PanicsWithValue(t, "boom", func() {
		_ = db.InTx(ctx, pool, func(tx pgx.Tx) error {
			if err := insertSetting(ctx, tx, "test.panic"); err != nil {
				return err
			}
			panic("boom")
		})
	})
	assert.Equal(t, 0, countSetting(t, pool, "test.panic"))
}
