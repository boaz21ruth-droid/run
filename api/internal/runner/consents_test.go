package runner_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner"
)

func day(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func registrationConsent(version, lang string, effective time.Time) runner.PublishConsentInput {
	return runner.PublishConsentInput{
		Purpose:       runner.PurposeRegistration,
		Version:       version,
		Lang:          lang,
		EffectiveDate: effective,
		FullText:      "# WeRun 报名同意书\n\n参赛者确认身体状况适合参赛。\n\n版本 " + version + " / " + lang + "\n",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "我已阅读并遵守赛事规则", Description: "包括关门时间与赛道规定"},
			{Key: "health", Title: "我的身体状况适合参赛"},
			{Key: "terms", Title: "我同意平台服务条款"},
		},
	}
}

// insertFreeSignup 建一场免费活动、一个组别和一条免费报名，返回报名 ID，给签署记录挂关联用。
func insertFreeSignup(t *testing.T, pool *pgxpool.Pool, userID int64) int64 {
	t.Helper()
	ctx := context.Background()
	var eventID, categoryID, signupID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO events (slug, event_type, organizer_type, name, city, race_date)
		 VALUES ('consent-fun-run', 'FREE_ACTIVITY', 'OFFICIAL', '{"en":"Consent fun run"}', 'Phnom Penh', '2026-10-01')
		 RETURNING id`).Scan(&eventID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
		 VALUES ($1, '5K', '{"en":"5K"}', 5000, 100)
		 RETURNING id`, eventID).Scan(&categoryID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO free_signups (signup_no, event_id, category_id, user_id, full_name, phone_e164, source)
		 VALUES ('FS0000CONS', $1, $2, $3, 'Sok Dara', '+85512345678', 'TELEGRAM')
		 RETURNING id`, eventID, categoryID, userID).Scan(&signupID))
	return signupID
}

func TestPublishConsentStoresHashItemsAndAudit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	in := registrationConsent("REG-v1", "zh", day(2026, 9, 1))

	require.NoError(t, f.svc.PublishConsent(ctx, in))

	var purpose, fullText string
	var effective time.Time
	var items, hash []byte
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT purpose, effective_date, full_text, items, text_sha256
		 FROM disclaimer_versions WHERE version = 'REG-v1' AND lang = 'zh'`).
		Scan(&purpose, &effective, &fullText, &items, &hash))
	assert.Equal(t, runner.PurposeRegistration, purpose)
	assert.True(t, effective.Equal(day(2026, 9, 1)))
	assert.Equal(t, in.FullText, fullText)
	sum := sha256.Sum256([]byte(in.FullText))
	assert.Equal(t, sum[:], hash)
	assert.JSONEq(t, `[
		{"k":"rules","t":"我已阅读并遵守赛事规则","d":"包括关门时间与赛道规定"},
		{"k":"health","t":"我的身体状况适合参赛"},
		{"k":"terms","t":"我同意平台服务条款"}
	]`, string(items))
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM audit_logs
		 WHERE action = 'consent.publish' AND actor_type = 'SYSTEM' AND entity_type = 'disclaimer_version'
		   AND entity_id = 0 AND after_data->>'version' = 'REG-v1' AND after_data->>'lang' = 'zh'`))
}

func TestPublishConsentVersionIsImmutable(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 9, 1))))

	changed := registrationConsent("REG-v1", "en", day(2026, 9, 2))
	changed.FullText = "different text"
	err := f.svc.PublishConsent(ctx, changed)

	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"version": "field.invalid"}, fieldKeys(t, err))
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_versions WHERE version = 'REG-v1'`))
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM audit_logs WHERE action = 'consent.publish'`))

	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "km", day(2026, 9, 1))), "同一版本的另一种语言可以发布")
	assert.Equal(t, 2, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_versions WHERE version = 'REG-v1'`))

	_, err = f.pool.Exec(ctx, `UPDATE disclaimer_versions SET full_text = 'tampered' WHERE version = 'REG-v1'`)
	require.Error(t, err, "迁移里的 forbid_mutation 触发器禁止修改已发布版本")
}

func TestPublishConsentValidatesInput(t *testing.T) {
	f := newFixture(t)
	cases := []struct {
		name   string
		mutate func(in *runner.PublishConsentInput)
		want   map[string]string
	}{
		{"unknown purpose", func(in *runner.PublishConsentInput) { in.Purpose = "MARKETING" }, map[string]string{"purpose": "field.invalid"}},
		{"missing purpose", func(in *runner.PublishConsentInput) { in.Purpose = "" }, map[string]string{"purpose": "field.required"}},
		{"version with space", func(in *runner.PublishConsentInput) { in.Version = "REG v1" }, map[string]string{"version": "field.invalid"}},
		{"missing version", func(in *runner.PublishConsentInput) { in.Version = "" }, map[string]string{"version": "field.required"}},
		{"unsupported lang", func(in *runner.PublishConsentInput) { in.Lang = "fr" }, map[string]string{"lang": "field.invalid"}},
		{"missing effective date", func(in *runner.PublishConsentInput) { in.EffectiveDate = time.Time{} }, map[string]string{"effectiveDate": "field.required"}},
		{"blank full text", func(in *runner.PublishConsentInput) { in.FullText = " \n " }, map[string]string{"fullText": "field.required"}},
		{"no items", func(in *runner.PublishConsentInput) { in.Items = nil }, map[string]string{"items": "field.required"}},
		{"duplicate key", func(in *runner.PublishConsentInput) { in.Items[1].Key = "rules" }, map[string]string{"items[1].key": "field.invalid"}},
		{"bad key", func(in *runner.PublishConsentInput) { in.Items[0].Key = "Rules!" }, map[string]string{"items[0].key": "field.invalid"}},
		{"missing key", func(in *runner.PublishConsentInput) { in.Items[2].Key = "" }, map[string]string{"items[2].key": "field.required"}},
		{"blank title", func(in *runner.PublishConsentInput) { in.Items[0].Title = "  " }, map[string]string{"items[0].title": "field.required"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := registrationConsent("REG-v1", "en", day(2026, 9, 1))
			tc.mutate(&in)

			err := f.svc.PublishConsent(context.Background(), in)

			requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
			assert.Equal(t, tc.want, fieldKeys(t, err))
		})
	}
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_versions`))
}

func TestCurrentConsentPicksLatestEffectiveVersionAndFallsBack(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for _, in := range []runner.PublishConsentInput{
		registrationConsent("REG-v1", "en", day(2026, 1, 1)),
		registrationConsent("REG-v2", "en", day(2026, 9, 14)),
		registrationConsent("REG-v3", "en", day(2026, 12, 1)),
		registrationConsent("REG-v2", "zh", day(2026, 9, 1)),
		{
			Purpose: runner.PurposeCommunity, Version: "UGC-v9", Lang: "en", EffectiveDate: day(2026, 9, 10),
			FullText: "Community disclaimer", Items: []runner.ConsentItem{{Key: "safety", Title: "I run at my own risk"}},
		},
	} {
		require.NoError(t, f.svc.PublishConsent(ctx, in))
	}
	f.clock.t = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC) // 金边 10:00

	got, err := f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "REG-v2", got.Version)
	assert.Equal(t, "en", got.Lang)
	assert.True(t, got.EffectiveDate.Equal(day(2026, 9, 14)))
	assert.Equal(t, registrationConsent("REG-v2", "en", day(2026, 9, 14)).FullText, got.FullText)
	assert.Equal(t, []runner.ConsentItem{
		{Key: "rules", Title: "我已阅读并遵守赛事规则", Description: "包括关门时间与赛道规定"},
		{Key: "health", Title: "我的身体状况适合参赛"},
		{Key: "terms", Title: "我同意平台服务条款"},
	}, got.Items)

	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.KM)
	require.NoError(t, err)
	assert.Equal(t, "REG-v2", got.Version)
	assert.Equal(t, "en", got.Lang, "没有高棉文版本时回退到英文")

	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.ZH)
	require.NoError(t, err)
	assert.Equal(t, "zh", got.Lang)

	got, err = f.svc.CurrentConsent(ctx, runner.PurposeCommunity, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "UGC-v9", got.Version, "不同 purpose 互不影响")

	f.clock.t = time.Date(2026, 9, 13, 16, 59, 59, 0, time.UTC) // 金边 9 月 13 日 23:59:59
	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "REG-v1", got.Version)

	f.clock.t = time.Date(2026, 9, 13, 17, 0, 0, 0, time.UTC) // 金边 9 月 14 日 00:00
	got, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	require.NoError(t, err)
	assert.Equal(t, "REG-v2", got.Version)
}

func TestCurrentConsentNotFoundAndInvalidPurpose(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	_, err := f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.ZH)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 12, 1))))
	_, err = f.svc.CurrentConsent(ctx, runner.PurposeRegistration, i18n.EN)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	_, err = f.svc.CurrentConsent(ctx, "MARKETING", i18n.EN)
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"purpose": "field.invalid"}, fieldKeys(t, err))
}

func TestSignConsentWritesSignatureAndLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	in := registrationConsent("REG-v1", "km", day(2026, 9, 1))
	require.NoError(t, f.svc.PublishConsent(ctx, in))
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	signupID := insertFreeSignup(t, f.pool, u.ID)
	acc := runner.ConsentAcceptance{Version: "REG-v1", Lang: "km", CheckedItems: []string{"terms", "rules", "health"}}
	link := runner.ConsentLink{FreeSignupID: &signupID}

	stop := errors.New("stop")
	err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		require.NoError(t, f.svc.SignConsent(ctx, tx, u, acc, testMeta, link))
		return stop
	})
	require.ErrorIs(t, err, stop)
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_signatures`), "随调用方事务回滚")

	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		return f.svc.SignConsent(ctx, tx, u, acc, testMeta, link)
	})
	require.NoError(t, err)

	var signatureID int64
	var checked, hash []byte
	var signedAt time.Time
	var ip, userAgent string
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT id, checked_items, text_sha256, signed_at, host(ip), user_agent
		 FROM disclaimer_signatures WHERE user_id = $1 AND version = 'REG-v1' AND lang = 'km'`, u.ID).
		Scan(&signatureID, &checked, &hash, &signedAt, &ip, &userAgent))
	assert.JSONEq(t, `["rules","health","terms"]`, string(checked), "按版本中的顺序记录")
	sum := sha256.Sum256([]byte(in.FullText))
	assert.Equal(t, sum[:], hash)
	assert.True(t, signedAt.Equal(baseNow))
	assert.Equal(t, "203.0.113.7", ip)
	assert.Equal(t, "runner-test", userAgent)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM registration_consents
		 WHERE signature_id = $1 AND free_signup_id = $2 AND reg_order_id IS NULL`, signatureID, signupID))
}

func TestSignConsentRejectsInvalidAcceptance(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 9, 1))))
	require.NoError(t, f.svc.PublishConsent(ctx, runner.PublishConsentInput{
		Purpose: runner.PurposeCommunity, Version: "UGC-v1", Lang: "en", EffectiveDate: day(2026, 9, 1),
		FullText: "Community disclaimer", Items: []runner.ConsentItem{{Key: "safety", Title: "I run at my own risk"}},
	}))
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	signupID := insertFreeSignup(t, f.pool, u.ID)

	cases := map[string]runner.ConsentAcceptance{
		"incomplete items":  {Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health"}},
		"no items":          {Version: "REG-v1", Lang: "en"},
		"extra item":        {Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health", "terms", "marketing"}},
		"duplicate item":    {Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health", "health"}},
		"unknown version":   {Version: "REG-v404", Lang: "en", CheckedItems: []string{"rules", "health", "terms"}},
		"missing language":  {Version: "REG-v1", Lang: "zh", CheckedItems: []string{"rules", "health", "terms"}},
		"community version": {Version: "UGC-v1", Lang: "en", CheckedItems: []string{"safety"}},
	}
	for name, acc := range cases {
		t.Run(name, func(t *testing.T) {
			err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
				return f.svc.SignConsent(ctx, tx, u, acc, testMeta, runner.ConsentLink{FreeSignupID: &signupID})
			})
			requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeConsentInvalid)
		})
	}
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_signatures`))
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM registration_consents`))
}

func TestSignConsentRequiresExactlyOneLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	require.NoError(t, f.svc.PublishConsent(ctx, registrationConsent("REG-v1", "en", day(2026, 9, 1))))
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	acc := runner.ConsentAcceptance{Version: "REG-v1", Lang: "en", CheckedItems: []string{"rules", "health", "terms"}}
	orderID, signupID := int64(1), int64(2)

	for name, link := range map[string]runner.ConsentLink{
		"neither": {},
		"both":    {RegOrderID: &orderID, FreeSignupID: &signupID},
	} {
		t.Run(name, func(t *testing.T) {
			err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
				return f.svc.SignConsent(ctx, tx, u, acc, testMeta, link)
			})
			require.Error(t, err)
			_, isAppErr := apperr.As(err)
			assert.False(t, isAppErr, "关联写错是调用方的编程错误，不是业务错误")
		})
	}
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM disclaimer_signatures`))

	// 数据库兜底：registration_consents 的 CHECK 约束拒绝两个关联都为空的行
	var signatureID int64
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO disclaimer_signatures (version, lang, text_sha256, user_id, checked_items)
		 VALUES ('REG-v1', 'en', $1, $2, '[]') RETURNING id`, []byte{0x01}, u.ID).Scan(&signatureID))
	_, err := f.pool.Exec(ctx, `INSERT INTO registration_consents (signature_id) VALUES ($1)`, signatureID)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "23514", pgErr.Code, "check_violation")
}
