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

func seedPriceRuleFor(t *testing.T, pool *pgxpool.Pool, eventID, categoryID int64) {
	t.Helper()
	ctx := context.Background()
	var ruleID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO price_rules (event_id, name, audience, price_cents) VALUES ($1, '{"en":"Standard"}', 'ALL', 2500) RETURNING id`,
		eventID).Scan(&ruleID))
	_, err := pool.Exec(ctx, `INSERT INTO category_price_rules (category_id, price_rule_id) VALUES ($1, $2)`, categoryID, ruleID)
	require.NoError(t, err)
}

func seedPaymentAccount(t *testing.T, pool *pgxpool.Pool, scope string, eventID *int64, active bool, currency string) {
	t.Helper()
	ctx := context.Background()
	var fileID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/' || md5(random()::text) || '.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 10, '\x01', 'SYSTEM')
		 RETURNING id`).Scan(&fileID))
	_, err := pool.Exec(ctx,
		`INSERT INTO payment_accounts (name, provider, account_name, account_no_masked, currency, qr_file_id, scope, event_id, active)
		 VALUES ('ABA USD', 'ABA', 'WERUN CO', '***123', $1, $2, $3, $4, $5)`,
		currency, fileID, scope, eventID, active)
	require.NoError(t, err)
}

func TestServiceGetAdminReturnsDraftsAndNotFound(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.getadmin")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)

	got, err := svc.GetAdmin(ctx, created.ID)

	require.NoError(t, err)
	require.Equal(t, event.StatusDraft, got.Status)
	require.Equal(t, "Asia/Phnom_Penh", got.Timezone)
	require.False(t, got.RegistrationOpen)
	require.Len(t, got.Categories, 1)

	_, err = svc.GetAdmin(ctx, 999999)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)
}

func TestServiceUpdateRegistrationChecksReadinessThenOpens(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.registration")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)
	opensAt := ptrTime("2026-09-20T08:00:00+07:00")
	closesAt := ptrTime("2026-11-01T23:59:00+07:00")
	open := event.RegistrationInput{Open: true, OpensAt: opensAt, ClosesAt: closesAt}

	_, err = svc.UpdateRegistration(ctx, actor, created.ID, open)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeRegistrationNotReady, ae.Code)
	require.Equal(t, []string{"PUBLISHED", "PRICE_RULE", "PAYMENT_ACCOUNT"}, ae.Params["missing"])
	require.Equal(t, []string{"21K"}, ae.Params["categories"])

	_, err = svc.Publish(ctx, actor, created.ID)
	require.NoError(t, err)
	otherEvent := validInput()
	otherEvent.Slug = "other-run"
	other, err := svc.Create(ctx, actor, otherEvent)
	require.NoError(t, err)
	// 这些账户都不算：绑定其他赛事、停用、只收周边、瑞尔
	seedPaymentAccount(t, pool, "ALL", &other.ID, true, "USD")
	seedPaymentAccount(t, pool, "REGISTRATION", nil, false, "USD")
	seedPaymentAccount(t, pool, "MERCH", nil, true, "USD")
	seedPaymentAccount(t, pool, "ALL", nil, true, "KHR")
	seedPriceRuleFor(t, pool, created.ID, created.Categories[0].ID)

	_, err = svc.UpdateRegistration(ctx, actor, created.ID, open)
	ae, ok = apperr.As(err)
	require.True(t, ok)
	require.Equal(t, []string{"PAYMENT_ACCOUNT"}, ae.Params["missing"])
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'event.registration_update'`))

	seedPaymentAccount(t, pool, "REGISTRATION", &created.ID, true, "USD")
	updated, err := svc.UpdateRegistration(ctx, actor, created.ID, open)

	require.NoError(t, err)
	require.True(t, updated.RegistrationOpen)
	require.True(t, updated.RegistrationOpensAt.Equal(*opensAt))
	require.True(t, updated.RegistrationClosesAt.Equal(*closesAt))
	require.Len(t, updated.Categories, 1)
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM events WHERE id = $1 AND registration_open AND registration_opens_at = $2`, created.ID, *opensAt))
	require.Equal(t, 1, countRows(t, pool,
		`SELECT count(*) FROM audit_logs WHERE action = 'event.registration_update' AND entity_type = 'event'
		   AND entity_id = $1 AND actor_id = $2 AND NOT is_financial
		   AND before_data->>'open' = 'false' AND after_data->>'open' = 'true'`, created.ID, actor.ID))

	closed, err := svc.UpdateRegistration(ctx, actor, created.ID, event.RegistrationInput{Open: false})
	require.NoError(t, err)
	require.False(t, closed.RegistrationOpen)
	require.Nil(t, closed.RegistrationOpensAt)
}

func TestServiceUpdateRegistrationFreeActivitySkipsPricingChecks(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.free")
	ctx := context.Background()
	in := validInput()
	in.Slug = "sunday-fun-run"
	in.EventType = event.TypeFreeActivity
	created, err := svc.Create(ctx, actor, in)
	require.NoError(t, err)
	_, err = svc.Publish(ctx, actor, created.ID)
	require.NoError(t, err)

	updated, err := svc.UpdateRegistration(ctx, actor, created.ID, event.RegistrationInput{Open: true})

	require.NoError(t, err)
	require.True(t, updated.RegistrationOpen)
}

func TestServiceUpdateRegistrationValidationAndNotFound(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.regvalidate")
	ctx := context.Background()

	_, err := svc.UpdateRegistration(ctx, actor, 1, event.RegistrationInput{
		OpensAt: ptrTime("2026-11-01T00:00:00Z"), ClosesAt: ptrTime("2026-10-01T00:00:00Z"),
	})
	require.Equal(t, "field.ends_before_starts", fieldKeys(t, err)["closesAt"])

	_, err = svc.UpdateRegistration(ctx, actor, 999999, event.RegistrationInput{})
	ae, ok := apperr.As(err)
	require.True(t, ok)
	require.Equal(t, apperr.CodeEventNotFound, ae.Code)
}

func TestServicePublicEventExposesRegistrationFields(t *testing.T) {
	pool := dbtest.NewPool(t)
	svc := event.NewService(pool)
	actor := newActor(t, pool, iam.RoleOps, "ops.public.fields")
	ctx := context.Background()
	created, err := svc.Create(ctx, actor, validInput())
	require.NoError(t, err)
	_, err = svc.Publish(ctx, actor, created.ID)
	require.NoError(t, err)
	opens := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	_, err = pool.Exec(ctx, `UPDATE events SET registration_open = true, registration_opens_at = $2 WHERE id = $1`, created.ID, opens)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE event_categories SET min_age = 16, used_count = 500, reserved_count = 300 WHERE event_id = $1`, created.ID)
	require.NoError(t, err)

	got, err := svc.GetPublic(ctx, "pphm-2026")

	require.NoError(t, err)
	require.True(t, got.RegistrationOpen)
	require.NotNil(t, got.RegistrationOpensAt)
	require.True(t, got.RegistrationOpensAt.Equal(opens))
	require.Nil(t, got.RegistrationClosesAt)
	require.Equal(t, int16(16), got.Categories[0].MinAge)
	require.Equal(t, int32(500), got.Categories[0].UsedCount)
	require.Equal(t, int32(300), got.Categories[0].ReservedCount)
}
