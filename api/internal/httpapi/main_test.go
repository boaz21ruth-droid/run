package httpapi

import (
	"os"
	"testing"

	"werun/api/internal/platform/dbtest"
)

// TestMain 保证本包用到的共享 postgres 测试容器在测试结束后被终止和清理；
// 详见 dbtest 包文档「容器生命周期与 TestMain」一节。
// 本目录下同时存在 httpapi 和 httpapi_test 两个测试包，但一个测试二进制只能有
// 一个 TestMain，放在这里即可覆盖整个二进制。
func TestMain(m *testing.M) {
	os.Exit(dbtest.Main(m))
}
