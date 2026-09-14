package db_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/dbtest"
)

type consentFixture struct {
	signatureIDs []int64
	orderID      int64
	freeSignupID int64
}

// seedConsentFixture 建一个跑者、一个赛事与组别、一张订单、一条免费报名、一版同意书和三条签署记录。
func seedConsentFixture(t *testing.T, pool *pgxpool.Pool) consentFixture {
	t.Helper()
	ctx := context.Background()
	var f consentFixture
	var userID, eventID, freeEventID, categoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users (telegram_user_id, display_name) VALUES (777000111, 'Sok Dara') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO events (slug, event_type, organizer_type, name, city, race_date)
		 VALUES ('consent-run', 'RACE', 'OFFICIAL', '{"en":"Consent Run"}', 'Phnom Penh', '2026-11-15') RETURNING id`).Scan(&eventID))
	// free_signups 要求关联的 event_type 为 FREE_ACTIVITY（0003 迁移的 free_signups_event_type 触发器），另建一个赛事供其使用。
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO events (slug, event_type, organizer_type, name, city, race_date)
		 VALUES ('consent-run-free', 'FREE_ACTIVITY', 'OFFICIAL', '{"en":"Consent Run Free"}', 'Phnom Penh', '2026-11-15') RETURNING id`).Scan(&freeEventID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO event_categories (event_id, code, name, distance_m, capacity)
		 VALUES ($1, '5K', '{"en":"5K"}', 5000, 100) RETURNING id`, eventID).Scan(&categoryID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO reg_orders (order_no, event_id, buyer_user_id, buyer_name, buyer_phone_e164, status, reservation_state,
		                         list_amount_cents, amount_cents)
		 VALUES ('WRCONSENT1', $1, $2, 'Sok Dara', '+85512345678', 'PENDING_PAYMENT', 'RESERVED', 2500, 2500) RETURNING id`,
		eventID, userID).Scan(&f.orderID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO free_signups (signup_no, event_id, category_id, user_id, full_name, phone_e164)
		 VALUES ('FSCONSENT1', $1, $2, $3, 'Sok Dara', '+85512345678') RETURNING id`,
		freeEventID, categoryID, userID).Scan(&f.freeSignupID))
	_, err := pool.Exec(ctx,
		`INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256, purpose)
		 VALUES ('REG-T-v1', 'en', '2026-09-01', 'Rules', '[{"k":"rules","t":"Rules","d":""}]', '\x01', 'REGISTRATION')`)
	require.NoError(t, err)
	for range 3 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO disclaimer_signatures (version, lang, text_sha256, user_id, checked_items)
			 VALUES ('REG-T-v1', 'en', '\x01', $1, '["rules"]') RETURNING id`, userID).Scan(&id))
		f.signatureIDs = append(f.signatureIDs, id)
	}
	return f
}

func TestDisclaimerVersionPurposeDefaultsToCommunity(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()

	_, err := pool.Exec(ctx,
		`INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256)
		 VALUES ('UGC-T-v1', 'zh', '2026-09-01', '正文', '[]', '\x01')`)
	require.NoError(t, err)

	var purpose string
	require.NoError(t, pool.QueryRow(ctx, `SELECT purpose FROM disclaimer_versions WHERE version = 'UGC-T-v1'`).Scan(&purpose))
	assert.Equal(t, "COMMUNITY", purpose)

	_, err = pool.Exec(ctx,
		`INSERT INTO disclaimer_versions (version, lang, effective_date, full_text, items, text_sha256, purpose)
		 VALUES ('BAD-T-v1', 'zh', '2026-09-01', '正文', '[]', '\x01', 'MERCH')`)
	assert.ErrorContains(t, err, "disclaimer_versions_purpose_check")
}

func TestRegistrationConsentsLinkExactlyOneTarget(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	f := seedConsentFixture(t, pool)

	_, err := pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id) VALUES ($1, $2)`, f.signatureIDs[0], f.orderID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, free_signup_id) VALUES ($1, $2)`, f.signatureIDs[1], f.freeSignupID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `INSERT INTO registration_consents (signature_id) VALUES ($1)`, f.signatureIDs[2])
	assert.ErrorContains(t, err, "registration_consents_check", "两个都为空")
	_, err = pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id, free_signup_id) VALUES ($1, $2, $3)`,
		f.signatureIDs[2], f.orderID, f.freeSignupID)
	assert.ErrorContains(t, err, "registration_consents_check", "两个都不为空")
	_, err = pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id) VALUES ($1, $2)`, f.signatureIDs[0], f.orderID)
	assert.ErrorContains(t, err, "registration_consents_pkey", "一条签署只关联一次")
}

func TestRegistrationConsentsAreAppendOnly(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	f := seedConsentFixture(t, pool)
	_, err := pool.Exec(ctx,
		`INSERT INTO registration_consents (signature_id, reg_order_id) VALUES ($1, $2)`, f.signatureIDs[0], f.orderID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE registration_consents SET created_at = now() WHERE signature_id = $1`, f.signatureIDs[0])
	assert.ErrorContains(t, err, "registration_consents is append-only")
	_, err = pool.Exec(ctx, `DELETE FROM registration_consents WHERE signature_id = $1`, f.signatureIDs[0])
	assert.ErrorContains(t, err, "registration_consents is append-only")

	var indexes int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM pg_indexes WHERE tablename = 'registration_consents'
		   AND indexname IN ('registration_consents_order_idx', 'registration_consents_free_idx')`).Scan(&indexes))
	assert.Equal(t, 2, indexes)
}
