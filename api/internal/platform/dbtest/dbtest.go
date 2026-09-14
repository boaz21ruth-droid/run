// Package dbtest 为集成测试提供彼此隔离、已执行全部迁移的 PostgreSQL 数据库。
//
// 同一测试进程只启动一个 postgres:16-alpine 容器，首次调用时建模板库并执行迁移；
// 之后每次 NewPool 都从模板库复制出一个新库，测试结束时删除。
// 设置 WERUN_TEST_DATABASE_URL（指向实例的维护库，如 postgres://u:p@host:5432/postgres）时不启动容器。
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
)

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
		container, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("postgres"),
			postgres.WithUsername("werun"),
			postgres.WithPassword("werun"),
			postgres.BasicWaitStrategies(),
		)
		if err != nil {
			return "", "", fmt.Errorf("start postgres container: %w", err)
		}
		baseURL, err = container.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			return "", "", fmt.Errorf("container connection string: %w", err)
		}
	}

	template := fmt.Sprintf("werun_template_%d", os.Getpid())
	if err := execAdmin(ctx, baseURL, "DROP DATABASE IF EXISTS "+template+" WITH (FORCE)"); err != nil {
		return "", "", fmt.Errorf("drop old template: %w", err)
	}
	if err := execAdmin(ctx, baseURL, "CREATE DATABASE "+template); err != nil {
		return "", "", fmt.Errorf("create template: %w", err)
	}
	templateURL, err := withDatabase(baseURL, template)
	if err != nil {
		return "", "", err
	}
	pool, err := db.Open(ctx, templateURL)
	if err != nil {
		return "", "", fmt.Errorf("open template: %w", err)
	}
	// 必须在复制前关闭：有连接连着模板库时 CREATE DATABASE ... TEMPLATE 会失败。
	defer pool.Close()
	if err := migrate.Up(ctx, pool, slog.New(slog.DiscardHandler)); err != nil {
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
