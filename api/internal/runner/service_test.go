package runner_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/piicrypt"
	"werun/api/internal/runner"
)

const testBotToken = "123456:runner-test-token"

var (
	testSessionSecret = []byte(strings.Repeat("s", 32))
	baseNow           = time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC)
	testMeta          = httpx.Meta{RequestID: "req-runner", IP: "203.0.113.7", UserAgent: "runner-test"}
)

type testClock struct{ t time.Time }

func (c *testClock) Now() time.Time { return c.t }

type fixture struct {
	pool  *pgxpool.Pool
	svc   *runner.Service
	clock *testClock
	pii   *piicrypt.Cipher
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	pool := dbtest.NewPool(t)
	pii, err := piicrypt.New([]byte(strings.Repeat("p", 32)))
	require.NoError(t, err)
	clock := &testClock{t: baseNow}
	return fixture{
		pool:  pool,
		svc:   runner.NewService(pool, testSessionSecret, testBotToken, pii, clock.Now),
		clock: clock,
		pii:   pii,
	}
}

func (f fixture) login(t *testing.T, tg runner.TelegramUser) runner.Session {
	t.Helper()
	initData := runner.SignInitData(testBotToken, tg, f.clock.t.Add(-time.Minute))
	sess, err := f.svc.LoginTelegram(context.Background(), initData, testMeta)
	require.NoError(t, err)
	return sess
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

func requireAppError(t *testing.T, err error, status int, code string) {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
}

func TestLoginTelegramCreatesUserSessionAndAudit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", LastName: "Sok", Username: "darasok", LanguageCode: "zh-hans"})

	assert.Len(t, sess.Token, 43, "32 字节 Base64 URL 无填充")
	assert.True(t, sess.ExpiresAt.Equal(baseNow.Add(runner.SessionTTL)))
	assert.NotZero(t, sess.User.ID)
	assert.Equal(t, int64(10001), sess.User.TelegramUserID)
	assert.Equal(t, "darasok", sess.User.TelegramUsername)
	assert.Equal(t, "Dara Sok", sess.User.DisplayName)
	assert.Equal(t, "zh", sess.User.Locale)

	var locale string
	var lastLogin time.Time
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT locale, last_login_at FROM users WHERE id = $1`, sess.User.ID).Scan(&locale, &lastLogin))
	assert.Equal(t, "zh", locale)
	assert.True(t, lastLogin.Equal(baseNow))
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM sessions
		 WHERE subject_type = 'USER' AND subject_id = $1 AND expires_at = $2
		   AND host(ip) = '203.0.113.7' AND user_agent = 'runner-test' AND revoked_at IS NULL`,
		sess.User.ID, baseNow.Add(24*time.Hour)))
	assert.Equal(t, 0, countRows(t, f.pool,
		`SELECT count(*) FROM sessions WHERE token_hash = convert_to($1, 'UTF8')`, sess.Token),
		"数据库里只存令牌的 HMAC")
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM audit_logs
		 WHERE action = 'runner.login' AND actor_type = 'USER' AND actor_id = $1
		   AND entity_type = 'user' AND entity_id = $1 AND NOT is_financial AND request_id = 'req-runner'`,
		sess.User.ID))
}

func TestLoginTelegramUpdatesExistingUserButKeepsLocale(t *testing.T) {
	f := newFixture(t)

	first := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", Username: "darasok", LanguageCode: "km"})
	f.clock.t = baseNow.Add(time.Hour)
	second := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", LastName: "Sok", Username: "dara_new", LanguageCode: "en"})

	assert.Equal(t, first.User.ID, second.User.ID)
	assert.Equal(t, "km", second.User.Locale, "只有首次创建时写 locale")
	assert.Equal(t, "dara_new", second.User.TelegramUsername)
	assert.Equal(t, "Dara Sok", second.User.DisplayName)
	assert.NotEqual(t, first.Token, second.Token)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM users WHERE telegram_user_id = 10001`))
	assert.Equal(t, 2, countRows(t, f.pool, `SELECT count(*) FROM sessions WHERE subject_type = 'USER' AND subject_id = $1`, first.User.ID))
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM users WHERE id = $1 AND last_login_at = $2`, first.User.ID, baseNow.Add(time.Hour)))
}

func TestLoginTelegramLocaleMapping(t *testing.T) {
	f := newFixture(t)
	cases := []struct {
		languageCode string
		want         string
	}{
		{"zh", "zh"},
		{"zh-hans", "zh"},
		{"zh-TW", "zh"},
		{"km", "km"},
		{"en", "en"},
		{"ru", "en"},
		{"", "en"},
	}
	for i, tc := range cases {
		sess := f.login(t, runner.TelegramUser{ID: int64(20001 + i), FirstName: "Runner", LanguageCode: tc.languageCode})
		assert.Equal(t, tc.want, sess.User.Locale, "language_code=%q", tc.languageCode)
	}
}

func TestLoginTelegramDisplayNameFallsBackToUsername(t *testing.T) {
	f := newFixture(t)

	sess := f.login(t, runner.TelegramUser{ID: 30001, Username: "only_username"})

	assert.Equal(t, "only_username", sess.User.DisplayName)
}

func TestLoginTelegramRejectsInvalidInitData(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	_, err := f.svc.LoginTelegram(ctx, "user=%7B%22id%22%3A1%7D&auth_date=1&hash=00", testMeta)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)

	otherBot := runner.SignInitData("999:other", runner.TelegramUser{ID: 10001, FirstName: "Dara"}, baseNow)
	_, err = f.svc.LoginTelegram(ctx, otherBot, testMeta)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)

	expired := runner.SignInitData(testBotToken, runner.TelegramUser{ID: 10001, FirstName: "Dara"}, baseNow.Add(-25*time.Hour))
	_, err = f.svc.LoginTelegram(ctx, expired, testMeta)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)

	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM users`))
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM sessions`))
}

func TestLoginTelegramRejectsBlankBotToken(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	svc := runner.NewService(f.pool, testSessionSecret, "", f.pii, f.clock.Now)

	forged := runner.SignInitData("", runner.TelegramUser{ID: 10001, FirstName: "Mallory"}, baseNow)
	_, err := svc.LoginTelegram(ctx, forged, testMeta)

	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeTelegramAuthInvalid)
	assert.Equal(t, 0, countRows(t, f.pool, `SELECT count(*) FROM users`))
}

func TestLoginTelegramRejectsDisabledUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})
	_, err := f.pool.Exec(ctx, `UPDATE users SET status = 'DISABLED' WHERE id = $1`, sess.User.ID)
	require.NoError(t, err)

	initData := runner.SignInitData(testBotToken, runner.TelegramUser{ID: 10001, FirstName: "Dara"}, baseNow)
	_, err = f.svc.LoginTelegram(ctx, initData, testMeta)

	requireAppError(t, err, http.StatusForbidden, apperr.CodeForbidden)
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM sessions WHERE subject_type = 'USER'`))
	assert.Equal(t, 1, countRows(t, f.pool, `SELECT count(*) FROM audit_logs WHERE action = 'runner.login'`))
}

func TestAuthenticateChecksExpiryRevocationAndStatus(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara", LanguageCode: "km"})

	got, err := f.svc.Authenticate(ctx, sess.Token)
	require.NoError(t, err)
	assert.Equal(t, sess.User, got)

	f.clock.t = baseNow.Add(runner.SessionTTL - time.Second)
	_, err = f.svc.Authenticate(ctx, sess.Token)
	require.NoError(t, err, "到期前 1 秒仍有效，且不续期")

	f.clock.t = baseNow.Add(runner.SessionTTL)
	_, err = f.svc.Authenticate(ctx, sess.Token)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM sessions WHERE subject_id = $1 AND expires_at = $2`, sess.User.ID, baseNow.Add(runner.SessionTTL)),
		"Authenticate 不修改 expires_at")

	f.clock.t = baseNow
	for _, bad := range []string{"", "not-base64!", "c2hvcnQ", strings.Repeat("A", 43)} {
		_, err = f.svc.Authenticate(ctx, bad)
		requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}

	_, err = f.pool.Exec(ctx, `UPDATE users SET status = 'DISABLED' WHERE id = $1`, sess.User.ID)
	require.NoError(t, err)
	_, err = f.svc.Authenticate(ctx, sess.Token)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func TestAuthenticateIgnoresStaffSessions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sess := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})
	_, err := f.pool.Exec(ctx, `UPDATE sessions SET subject_type = 'STAFF' WHERE subject_id = $1`, sess.User.ID)
	require.NoError(t, err)

	_, err = f.svc.Authenticate(ctx, sess.Token)

	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
}

func TestLogoutRevokesOnlyThatSession(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	first := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})
	second := f.login(t, runner.TelegramUser{ID: 10001, FirstName: "Dara"})

	require.NoError(t, f.svc.Logout(ctx, first.Token))

	_, err := f.svc.Authenticate(ctx, first.Token)
	requireAppError(t, err, http.StatusUnauthorized, apperr.CodeUnauthenticated)
	_, err = f.svc.Authenticate(ctx, second.Token)
	require.NoError(t, err)
	assert.Equal(t, 1, countRows(t, f.pool,
		`SELECT count(*) FROM sessions WHERE subject_type = 'USER' AND revoked_at = $1`, baseNow))

	require.NoError(t, f.svc.Logout(ctx, "not-a-token"))
	require.NoError(t, f.svc.Logout(ctx, first.Token), "重复退出不报错")
}
