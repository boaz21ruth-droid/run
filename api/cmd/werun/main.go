// Command werun 是 WeRun 后端的唯一二进制：HTTP 服务、迁移、健康检查等子命令。
package main

import (
	"context"
	"fmt"
	"io"
	"os"
)

const usage = `werun <command> [flags]

Commands:
  serve        启动 HTTP 服务（--auto-migrate：启动前执行迁移，只用于本地开发）
  migrate      数据库迁移：werun migrate up | down | status
  healthcheck  请求就绪接口，返回 200 时退出码为 0（--url 指定地址）
`

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve":
		return runServe(ctx, args[1:], stderr)
	case "migrate":
		return runMigrate(ctx, args[1:], stdout, stderr)
	case "healthcheck":
		return runHealthcheck(ctx, args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}
