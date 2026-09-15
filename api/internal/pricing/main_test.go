package pricing_test

import (
	"os"
	"testing"

	"werun/api/internal/platform/dbtest"
)

// TestMain 保证本包用到的共享 postgres 测试容器在测试结束后被终止和清理；
// 详见 dbtest 包文档「容器生命周期与 TestMain」一节。
func TestMain(m *testing.M) {
	os.Exit(dbtest.Main(m))
}
