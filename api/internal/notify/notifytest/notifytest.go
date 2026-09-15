// Package notifytest 为其他包的测试构造 notify.Service：River 客户端只插入不执行，文案用内置目录。
// 不得依赖 internal/jobs（jobs 依赖 registration，会形成导入循环）。只允许在测试中导入。
package notifytest

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"werun/api/internal/notify"
	"werun/api/internal/platform/i18n"
)

// AppBaseURL 是测试里按钮链接的前缀。
const AppBaseURL = "https://app.werun.test"

// New 返回写入 pool 的 notify.Service。
func New(t testing.TB, pool *pgxpool.Pool) *notify.Service {
	t.Helper()
	inserter, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("notifytest: create river insert-only client: %v", err)
	}
	cat, err := i18n.LoadCatalog()
	if err != nil {
		t.Fatalf("notifytest: load catalog: %v", err)
	}
	return notify.NewService(inserter, cat, AppBaseURL)
}
