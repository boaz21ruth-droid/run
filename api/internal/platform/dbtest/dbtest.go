// Package dbtest 为集成测试提供彼此隔离、已执行全部迁移的 PostgreSQL 数据库。
//
// 同一测试进程只启动一个 postgres:16-alpine 容器，首次调用时建模板库并执行迁移；
// 之后每次 NewPool 都从模板库复制出一个新库，测试结束时删除。
// 设置 WERUN_TEST_DATABASE_URL（指向实例的维护库，如 postgres://u:p@host:5432/postgres）时不启动容器。
//
// # 容器生命周期与 TestMain
//
// 本地在 colima 下跑 Docker 时测试以 TESTCONTAINERS_RYUK_DISABLED=true 运行（colima 不带
// Ryuk 需要的网络能力），因此 testcontainers 自带的“测试进程退出后自动回收容器”机制不生效：
// 谁启动的容器就必须由谁显式终止，否则容器会一直占着内存常驻，多跑几次就能把宿主机内存耗光
// （历史上已经因此吃掉过 93 个残留容器并连带压垮了无关的容器）。
//
// 因此：任何调用本包 NewPool（或间接调用它）的测试包，都必须在包内添加：
//
//	func TestMain(m *testing.M) { os.Exit(dbtest.Main(m)) }
//
// 如果该包已经有自己的 TestMain，把 dbtest.Main 的逻辑合并进去即可（先跑 m.Run()，
// 再调用 dbtest 提供的收尾）。新增任何会用到 dbtest.NewPool 的测试包时，照此加一份 TestMain——
// 忘记加不会导致测试失败，但会在本机悄悄再泄漏一个容器。
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"werun/api/internal/platform/db"
	"werun/api/internal/platform/migrate"
)

var (
	setupOnce    sync.Once
	adminURL     string
	templateName string
	setupErr     error
	// container 仅在本进程确实启动了容器（即未设置 WERUN_TEST_DATABASE_URL）时非 nil。
	// 只在 setupOnce.Do 内写入，在其完成之后（即 Main 里）读取，不存在并发读写。
	container *postgres.PostgresContainer
)

// Main 运行一个测试包的所有测试（m.Run()），然后终止并清理本包可能启动的共享
// postgres 容器（连同其匿名卷）。它返回应当传给 os.Exit 的退出码。
//
// 用法：
//
//	func TestMain(m *testing.M) { os.Exit(dbtest.Main(m)) }
//
// 每一个（直接或间接）调用 NewPool 的测试包都必须有这样一个 TestMain，否则该包
// 启动的容器在本机（Ryuk 被禁用）永远不会被回收。见包文档。
//
// 设计取舍：容器终止失败只记录到 stderr，不会让原本通过的测试结果变成失败——
// 清理失败是环境/Docker 层面的问题，不代表被测代码有问题；把它算作测试失败会让
// CI 因为宿主机偶发的 Docker 问题而误报，掩盖真正的信号。测试本身失败时，
// 退出码依然如实反映 m.Run() 的结果。
func Main(m *testing.M) int {
	code := m.Run()
	cleanup()
	return code
}

func cleanup() {
	if container == nil {
		return
	}
	c := container
	// 立即清空，避免 setup 失败路径已经调用过一次之后，Main 结束时再对同一个
	// （可能已经被移除的）容器调用第二次 Terminate。
	container = nil
	ctx := context.Background()
	// Terminate 默认会连同容器的匿名卷一起强制删除（RemoveVolumes: true）。
	if err := c.Terminate(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "dbtest: terminate postgres container: %v\n", err)
	}
}

// NewPool 返回连接到一个全新测试库的连接池，测试结束时自动关闭并删库。
func NewPool(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	setupOnce.Do(func() {
		adminURL, templateName, setupErr = setup(ctx)
	})
	if setupErr != nil {
		t.Fatalf("dbtest: set up postgres: %v", setupErr)
	}

	name := "werun_test_" + randomSuffix()
	if err := execAdmin(ctx, adminURL, "CREATE DATABASE "+name+" TEMPLATE "+templateName); err != nil {
		t.Fatalf("dbtest: create database %s: %v", name, err)
	}
	dbURL, err := withDatabase(adminURL, name)
	if err != nil {
		t.Fatalf("dbtest: build url: %v", err)
	}
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("dbtest: open %s: %v", name, err)
	}
	t.Cleanup(func() {
		pool.Close()
		if err := execAdmin(context.Background(), adminURL, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Logf("dbtest: drop database %s: %v", name, err)
		}
	})
	return pool
}

func setup(ctx context.Context) (string, string, error) {
	baseURL := os.Getenv("WERUN_TEST_DATABASE_URL")
	if baseURL == "" {
		c, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("postgres"),
			postgres.WithUsername("werun"),
			postgres.WithPassword("werun"),
			postgres.BasicWaitStrategies(),
		)
		if err != nil {
			return "", "", fmt.Errorf("start postgres container: %w", err)
		}
		// 从这里开始，容器已经在跑：后面任何一步失败都必须先终止它再返回错误，
		// 否则 Main 永远拿不到这个容器的引用去清理（历史缺陷：曾导致失败的
		// setup 悄悄泄漏容器）。
		container = c
		baseURL, err = c.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			cleanup()
			return "", "", fmt.Errorf("container connection string: %w", err)
		}
	}

	template := fmt.Sprintf("werun_template_%d", os.Getpid())
	if err := execAdmin(ctx, baseURL, "DROP DATABASE IF EXISTS "+template+" WITH (FORCE)"); err != nil {
		cleanup()
		return "", "", fmt.Errorf("drop old template: %w", err)
	}
	if err := execAdmin(ctx, baseURL, "CREATE DATABASE "+template); err != nil {
		cleanup()
		return "", "", fmt.Errorf("create template: %w", err)
	}
	templateURL, err := withDatabase(baseURL, template)
	if err != nil {
		cleanup()
		return "", "", err
	}
	pool, err := db.Open(ctx, templateURL)
	if err != nil {
		cleanup()
		return "", "", fmt.Errorf("open template: %w", err)
	}
	// 必须在复制前关闭：有连接连着模板库时 CREATE DATABASE ... TEMPLATE 会失败。
	defer pool.Close()
	if err := migrate.Up(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
		cleanup()
		return "", "", fmt.Errorf("migrate template: %w", err)
	}
	return baseURL, template, nil
}

func execAdmin(ctx context.Context, connURL, statement string) error {
	conn, err := pgx.Connect(ctx, connURL)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, statement)
	return err
}

func withDatabase(connURL, name string) (string, error) {
	u, err := url.Parse(connURL)
	if err != nil {
		return "", fmt.Errorf("parse database url: %w", err)
	}
	u.Path = "/" + name
	return u.String(), nil
}

func randomSuffix() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
