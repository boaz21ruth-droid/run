package migrate_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/migrate"
)

func TestUpCreatesBusinessAndRiverTables(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	var business int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public'
		  AND table_type = 'BASE TABLE'
		  AND table_name NOT LIKE 'river\_%'
		  AND table_name <> 'goose_db_version'`).Scan(&business))
	assert.Equal(t, 69, business)

	var hasRiverJob bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT to_regclass('public.river_job') IS NOT NULL`).Scan(&hasRiverJob))
	assert.True(t, hasRiverJob)
}

func TestStatusListsEveryMigrationAsApplied(t *testing.T) {
	pool := dbtest.NewPool(t)

	lines, err := migrate.Status(context.Background(), pool)

	require.NoError(t, err)
	require.Len(t, lines, 9)
	assert.Equal(t, "0001_foundation.sql applied", lines[0])
	for _, line := range lines {
		assert.True(t, strings.HasSuffix(line, " applied"), line)
	}
}

func TestUpIsIdempotent(t *testing.T) {
	pool := dbtest.NewPool(t)

	err := migrate.Up(context.Background(), pool, slog.New(slog.DiscardHandler))

	assert.NoError(t, err)
}

func TestDownUnmarksLatestVersion(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	require.NoError(t, migrate.Down(ctx, pool, slog.New(slog.DiscardHandler)))

	lines, err := migrate.Status(ctx, pool)
	require.NoError(t, err)
	assert.Equal(t, "0009_content_community.sql pending", lines[len(lines)-1])
	assert.Equal(t, "0008_results_photos.sql applied", lines[len(lines)-2])
}
