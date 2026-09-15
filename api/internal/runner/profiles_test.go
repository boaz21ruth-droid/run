package runner_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/runner"
)

func selfProfileIDs(t *testing.T, pool *pgxpool.Pool, userID int64) []int64 {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id FROM runner_profiles WHERE user_id = $1 AND is_self ORDER BY id`, userID)
	require.NoError(t, err)
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	require.NoError(t, err)
	return ids
}

func storedIDNo(t *testing.T, pool *pgxpool.Pool, profileID int64) (enc, hash []byte) {
	t.Helper()
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT id_no_enc, id_no_hash FROM runner_profiles WHERE id = $1`, profileID).Scan(&enc, &hash))
	return enc, hash
}

func TestCreateProfileEncryptsIDNoAndMasksOutput(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User

	created, err := f.svc.CreateProfile(ctx, u, validProfile(), true)

	require.NoError(t, err)
	assert.NotZero(t, created.ID)
	assert.True(t, created.IsSelf)
	assert.Equal(t, "******5678", created.IDNoMasked)
	assert.Equal(t, runner.ProfileData{
		FullName:       "Sok Dara",
		Gender:         "M",
		BirthDate:      time.Date(1990, 5, 1, 0, 0, 0, 0, time.UTC),
		Nationality:    "KH",
		IDType:         "NATIONAL_ID",
		IDNo:           "",
		Phone:          "+85512345678",
		Email:          "dara@example.com",
		EmergencyName:  "Sok Chenda",
		EmergencyPhone: "+85598765432",
		TShirtSize:     "M",
	}, created.Data)

	enc, hash := storedIDNo(t, f.pool, created.ID)
	assert.NotContains(t, string(enc), "N012345678")
	assert.Equal(t, f.pii.Hash("N012345678"), hash)
	plain, err := f.svc.PII().Decrypt(enc)
	require.NoError(t, err)
	assert.Equal(t, "N012345678", plain)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles WHERE user_id = $1`, u.ID))
}

func TestCreateProfileRejectsInvalidDataWithoutWriting(t *testing.T) {
	f := newFixture(t)
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	p := validProfile()
	p.Phone = "012345678"
	p.IDNo = ""

	_, err := f.svc.CreateProfile(context.Background(), u, p, false)

	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"phone": "field.invalid", "idNo": "field.required"}, fieldKeys(t, err))
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles`))
}

func TestOnlyOneSelfProfilePerUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	other := f.login(t, runner.TelegramUser{ID: 10002, FirstName: "Sokha"}).User

	a, err := f.svc.CreateProfile(ctx, u, validProfile(), true)
	require.NoError(t, err)
	otherSelf, err := f.svc.CreateProfile(ctx, other, validProfile(), true)
	require.NoError(t, err)

	second := validProfile()
	second.FullName = "Sok Chenda"
	second.IDNo = "P9876543"
	b, err := f.svc.CreateProfile(ctx, u, second, true)
	require.NoError(t, err)
	assert.Equal(t, []int64{b.ID}, selfProfileIDs(t, f.pool, u.ID))

	keep := validProfile()
	keep.IDNo = ""
	updated, err := f.svc.UpdateProfile(ctx, u, a.ID, keep, true)
	require.NoError(t, err)
	assert.True(t, updated.IsSelf)
	assert.Equal(t, []int64{a.ID}, selfProfileIDs(t, f.pool, u.ID))
	assert.Equal(t, []int64{otherSelf.ID}, selfProfileIDs(t, f.pool, other.ID), "不影响其他跑者")

	list, err := f.svc.ListProfiles(ctx, u)
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, a.ID, list[0].ID, "本人排在最前")
	assert.Equal(t, b.ID, list[1].ID)
	assert.Equal(t, "****6543", list[1].IDNoMasked)
	assert.Empty(t, list[0].Data.IDNo)
	assert.Empty(t, list[1].Data.IDNo)
}

func TestUpdateProfileKeepsIDNoWhenEmpty(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), false)
	require.NoError(t, err)
	_, hashBefore := storedIDNo(t, f.pool, created.ID)

	in := validProfile()
	in.IDNo = ""
	in.FullName = "Sok Dara Jr"
	in.Email = ""
	updated, err := f.svc.UpdateProfile(ctx, u, created.ID, in, false)

	require.NoError(t, err)
	assert.Equal(t, "Sok Dara Jr", updated.Data.FullName)
	assert.Empty(t, updated.Data.Email)
	assert.Equal(t, "******5678", updated.IDNoMasked)
	_, hashAfter := storedIDNo(t, f.pool, created.ID)
	assert.Equal(t, hashBefore, hashAfter)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles WHERE id = $1 AND email IS NULL`, created.ID))

	in.IDNo = "p 7777-8888"
	updated, err = f.svc.UpdateProfile(ctx, u, created.ID, in, false)
	require.NoError(t, err)
	assert.Equal(t, "*****8888", updated.IDNoMasked)
	_, hashChanged := storedIDNo(t, f.pool, created.ID)
	assert.Equal(t, f.pii.Hash("P77778888"), hashChanged)
}

func TestUpdateProfileValidatesInput(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), false)
	require.NoError(t, err)

	in := validProfile()
	in.IDNo = "12"
	in.TShirtSize = "XXXL"
	_, err = f.svc.UpdateProfile(ctx, u, created.ID, in, false)

	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"idNo": "field.invalid", "tshirtSize": "field.invalid"}, fieldKeys(t, err))
}

func TestProfilesAreScopedToOwner(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	other := f.login(t, runner.TelegramUser{ID: 10002, FirstName: "Sokha"}).User
	created, err := f.svc.CreateProfile(ctx, owner, validProfile(), false)
	require.NoError(t, err)

	_, err = f.svc.UpdateProfile(ctx, other, created.ID, validProfile(), true)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	err = f.svc.DeleteProfile(ctx, other, created.ID)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)

	list, err := f.svc.ListProfiles(ctx, other)
	require.NoError(t, err)
	assert.Empty(t, list)

	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := f.svc.LoadProfileForOrder(ctx, tx, other, created.ID, "participants[0].")
		return err
	})
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
	assert.Equal(t, map[string]string{"participants[0].profileId": "field.invalid"}, fieldKeys(t, err))

	ownerList, err := f.svc.ListProfiles(ctx, owner)
	require.NoError(t, err)
	require.Len(t, ownerList, 1)
	assert.Equal(t, "Sok Dara", ownerList[0].Data.FullName)
}

func TestDeleteProfile(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), true)
	require.NoError(t, err)

	require.NoError(t, f.svc.DeleteProfile(ctx, u, created.ID))

	list, err := f.svc.ListProfiles(ctx, u)
	require.NoError(t, err)
	assert.Empty(t, list)
	err = f.svc.DeleteProfile(ctx, u, created.ID)
	requireAppError(t, err, http.StatusNotFound, apperr.CodeNotFound)
}

func TestLoadProfileForOrderReturnsFullIDNo(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	created, err := f.svc.CreateProfile(ctx, u, validProfile(), false)
	require.NoError(t, err)

	var got runner.ProfileData
	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		var err error
		got, err = f.svc.LoadProfileForOrder(ctx, tx, u, created.ID, "participants[0].")
		return err
	})

	require.NoError(t, err)
	want := created.Data
	want.IDNo = "N012345678"
	assert.Equal(t, want, got)
}

func TestCreateProfileTxUsesCallerTransaction(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"}).User
	stop := errors.New("stop")

	var rolledBackID int64
	err := db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		id, err := f.svc.CreateProfileTx(ctx, tx, u, validProfile())
		require.NoError(t, err)
		rolledBackID = id
		return stop
	})
	require.ErrorIs(t, err, stop)
	assert.NotZero(t, rolledBackID)
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM runner_profiles`))

	var id int64
	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		var err error
		id, err = f.svc.CreateProfileTx(ctx, tx, u, validProfile())
		return err
	})
	require.NoError(t, err)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM runner_profiles WHERE id = $1 AND user_id = $2 AND NOT is_self AND nationality = 'KH'`, id, u.ID))

	err = db.InTx(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := f.svc.CreateProfileTx(ctx, tx, u, runner.ProfileData{})
		return err
	})
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeValidation)
}
