package event_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
)

func newActor(t *testing.T, pool *pgxpool.Pool, role iam.Role, username string) iam.Staff {
	t.Helper()
	svc := iam.NewService(pool, []byte(strings.Repeat("s", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	staff, err := svc.CreateStaff(context.Background(), username, "Test "+string(role), role, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	return staff
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func TestServiceCreateWritesEventCategoriesAndAudit(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.create")

	created, err := svc.Create(context.Background(), actor, validInput())

	require.NoError(t, err)
	require.NotZero(t, created.ID)
	require.Equal(t, event.StatusDraft, created.Status)
	require.False(t, created.PublicVisible)
	require.Nil(t, created.PublishedAt)
	require.Equal(t, "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦", created.Name[i18n.KM])
	require.True(t, created.RaceDate.Equal(time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)))
	require.Len(t, created.Categories, 1)
	require.Equal(t, "21K", created.Categories[0].Code)
	require.NotNil(t, created.Categories[0].StartAt)
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'event.create' AND entity_type = 'event' AND entity_id = $1 AND actor_id = $2`,
		created.ID, actor.ID))
}

func TestServiceCreateRejectsDuplicateSlug(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.dup")
	ctx := context.Background()

	_, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)
	_, err = svc.Create(ctx, actor, validInput())

	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeEventSlugTaken, ae.Code)
	require.Equal(t, http.StatusConflict, ae.Status)
	require.Equal(t, apperr.CodeEventSlugTaken, fieldKeys(t, err)["slug"])
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM events WHERE slug = 'pphm-2026'`))
}

func TestServiceCreateValidationFailureWritesNothing(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.invalid")
	in := validInput()
	in.Slug = ""

	_, err := svc.Create(context.Background(), actor, in)

	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeValidation, ae.Code)
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM events`))
}

func TestServicePublishRejectsIncompleteCategory(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.incomplete")
	ctx := context.Background()
	in := validInput()
	in.Categories[0].StartAt = nil
	in.Categories[0].CutoffAt = nil
	created, err := svc.Create(ctx, actor, in)
	require.NoError(t, err)

	_, err = svc.Publish(ctx, actor, created.ID)

	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeEventCategoryIncomplete, ae.Code)
	require.Equal(t, "21K: start_at, cutoff_at", ae.Fields["categories"].Params["missing"])
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM events WHERE id = $1 AND status = 'DRAFT'`, created.ID))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'event.publish'`))
}

func TestServicePublishSucceedsOnceAndIsAudited(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.publish")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)

	published, err := svc.Publish(ctx, actor, created.ID)

	require.NoError(t, err)
	require.Equal(t, event.StatusPublished, published.Status)
	require.True(t, published.PublicVisible)
	require.NotNil(t, published.PublishedAt)
	require.Len(t, published.Categories, 1)
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'event.publish' AND entity_id = $1`, created.ID))

	_, err = svc.Publish(ctx, actor, created.ID)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventAlreadyPublished, ae.Code)
	require.Equal(t, http.StatusConflict, ae.Status)
}

func TestServicePublishUnknownEvent(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.unknown")

	_, err := svc.Publish(context.Background(), actor, 999999)

	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)
	require.Equal(t, http.StatusNotFound, ae.Status)
}

func TestServicePublicQueriesExcludeDrafts(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.list")
	ctx := context.Background()

	draft := validInput()
	draft.Slug = "draft-run"
	_, err := svc.Create(ctx, actor, draft)
	require.NoError(t, err)

	live := validInput()
	live.Slug = "published-run"
	liveEvent, err := svc.Create(ctx, actor, live)
	require.NoError(t, err)
	_, err = svc.Publish(ctx, actor, liveEvent.ID)
	require.NoError(t, err)

	public, err := svc.ListPublic(ctx)
	require.NoError(t, err)
	require.Len(t, public, 1)
	require.Equal(t, "published-run", public[0].Slug)
	require.Len(t, public[0].Categories, 1)

	got, err := svc.GetPublic(ctx, "published-run")
	require.NoError(t, err)
	require.Equal(t, liveEvent.ID, got.ID)

	_, err = svc.GetPublic(ctx, "draft-run")
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)

	all, err := svc.ListAll(ctx)
	require.NoError(t, err)
	require.Len(t, all, 2)
}
