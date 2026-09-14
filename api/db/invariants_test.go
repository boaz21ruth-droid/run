package db_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/db"
	"werun/api/internal/platform/dbtest"
)

// stripPsqlMeta 去掉 psql 元命令（以 \ 开头的行），pgx 不认识这些命令。
func stripPsqlMeta(script string) string {
	lines := strings.Split(script, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), `\`) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// TestInvariants 执行 db/tests/invariants_test.sql。脚本在事务里构造数据、
// 逐条触发数据库约束并 ROLLBACK，用 RAISE NOTICE 输出 PASS / FAIL。
// 脚本新增用例时同步修改期望的 PASS 数量。
func TestInvariants(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	var mu sync.Mutex
	var notices []string
	cfg := pool.Config().ConnConfig.Copy()
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		mu.Lock()
		defer mu.Unlock()
		notices = append(notices, n.Message)
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	require.NoError(t, err)
	defer conn.Close(ctx)

	_, err = conn.Exec(ctx, stripPsqlMeta(db.InvariantsSQL))
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	var passed int
	var failed []string
	for _, msg := range notices {
		switch {
		case strings.HasPrefix(msg, "PASS"):
			passed++
		case strings.HasPrefix(msg, "FAIL"):
			failed = append(failed, msg)
		}
	}
	assert.Empty(t, failed)
	assert.Equal(t, 23, passed)
}
