// Package migrate 执行数据库迁移：先执行 goose 业务迁移（db/migrations），再执行 River 自带迁移。
package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"log/slog"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"werun/api/db"
)

func newProvider(pool *pgxpool.Pool, log *slog.Logger) (*goose.Provider, *sql.DB, error) {
	migrations, err := fs.Sub(db.Migrations, "migrations")
	if err != nil {
		return nil, nil, fmt.Errorf("open embedded migrations: %w", err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations, goose.WithSlog(log))
	if err != nil {
		_ = sqlDB.Close()
		return nil, nil, fmt.Errorf("create goose provider: %w", err)
	}
	return provider, sqlDB, nil
}

// Up 执行全部未执行的业务迁移，然后执行 River 迁移。重复执行是安全的。
func Up(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	provider, sqlDB, err := newProvider(pool, log)
	if err != nil {
		return err
	}
	defer sqlDB.Close()

	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	for _, r := range results {
		log.InfoContext(ctx, "migration applied", "file", filepath.Base(r.Source.Path), "duration", r.Duration)
	}

	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Logger: log})
	if err != nil {
		return fmt.Errorf("create river migrator: %w", err)
	}
	res, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
	if err != nil {
		return fmt.Errorf("river migrate up: %w", err)
	}
	for _, v := range res.Versions {
		log.InfoContext(ctx, "river migration applied", "version", v.Version, "name", v.Name)
	}
	return nil
}

// Down 把最新的业务迁移标记为未执行。迁移文件没有 Down 段，因此不会删除任何表；
// 本地需要回退结构时请重建数据库。River 迁移不受影响。
func Down(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	provider, sqlDB, err := newProvider(pool, log)
	if err != nil {
		return err
	}
	defer sqlDB.Close()

	result, err := provider.Down(ctx)
	if err != nil {
		return fmt.Errorf("goose down: %w", err)
	}
	log.InfoContext(ctx, "migration rolled back", "file", filepath.Base(result.Source.Path))
	return nil
}

// Status 返回每个业务迁移的状态，每行形如 "0001_foundation.sql applied"。
func Status(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	provider, sqlDB, err := newProvider(pool, slog.New(slog.DiscardHandler))
	if err != nil {
		return nil, err
	}
	defer sqlDB.Close()

	statuses, err := provider.Status(ctx)
	if err != nil {
		return nil, fmt.Errorf("goose status: %w", err)
	}
	lines := make([]string, 0, len(statuses))
	for _, s := range statuses {
		lines = append(lines, fmt.Sprintf("%s %s", filepath.Base(s.Source.Path), s.State))
	}
	return lines, nil
}
