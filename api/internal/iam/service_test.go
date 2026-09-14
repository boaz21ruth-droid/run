package iam

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/httpx"
)

const testSecret = "0123456789abcdef0123456789abcdef"

var testMeta = httpx.Meta{RequestID: "req-test", IP: "203.0.113.7", UserAgent: "go-test"}

func newTestService(t *testing.T) (*Service, *fakeClock, *pgxpool.Pool) {
	t.Helper()
	pool := dbtest.NewPool(t)
	clock := newFakeClock()
	return NewService(pool, []byte(testSecret), NewLoginLimiter(clock.Now), clock.Now), clock, pool
}

func createOps(t *testing.T, svc *Service) Staff {
	t.Helper()
	staff, err := svc.CreateStaff(context.Background(), "ops.chan", "Chanthou Ny", RoleOps, "correct-horse-1")
	require.NoError(t, err)
	return staff
}

func requireCode(t *testing.T, err error, code string) *apperr.Error {
	t.Helper()
	appErr, ok := apperr.As(err)
	require.True(t, ok, "want *apperr.Error, got %v", err)
	assert.Equal(t, code, appErr.Code)
	return appErr
}

func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), query, args...).Scan(&n))
	return n
}

func sessionExpiry(t *testing.T, pool *pgxpool.Pool) time.Time {
	t.Helper()
	var expires time.Time
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT expires_at FROM sessions ORDER BY id LIMIT 1`).Scan(&expires))
	return expires
}

func TestCreateStaffValidation(t *testing.T) {
	svc, _, _ := newTestService(t)

	_, err := svc.CreateStaff(context.Background(), "Ops Chan", "", Role("GHOST"), "short")
	appErr := requireCode(t, err, apperr.CodeValidation)
	assert.Equal(t, "field.invalid", appErr.Fields["username"].Key)
	assert.Equal(t, "field.required", appErr.Fields["fullName"].Key)
	assert.Equal(t, "field.invalid", appErr.Fields["role"].Key)
	assert.Equal(t, "field.invalid", appErr.Fields["password"].Key)
}

func TestCreateStaffDuplicateUsername(t *testing.T) {
	svc, _, _ := newTestService(t)
	createOps(t, svc)

	_, err := svc.CreateStaff(context.Background(), "ops.chan", "Another", RoleAdmin, "correct-horse-2")
	appErr := requireCode(t, err, apperr.CodeValidation)
	assert.Equal(t, "field.invalid", appErr.Fields["username"].Key)
}

func TestLoginSuccess(t *testing.T) {
	svc, clock, pool := newTestService(t)
	ops := createOps(t, svc)

	token, staff, err := svc.Login(context.Background(), " OPS.CHAN ", "correct-horse-1", testMeta)
	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.Equal(t, ops, staff)

	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM sessions WHERE subject_type = 'STAFF' AND subject_id = $1`, ops.ID))
	assert.True(t, sessionExpiry(t, pool).Equal(clock.Now().Add(IdleTimeout)))
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'staff.login' AND entity_id = $1`, ops.ID))
	assert.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM sessions WHERE token_hash = $1`, []byte(token)),
		"plain token must never be stored")
}

func TestLoginWrongPassword(t *testing.T) {
	svc, _, pool := newTestService(t)
	ops := createOps(t, svc)

	_, _, err := svc.Login(context.Background(), "ops.chan", "wrong-password", testMeta)
	_ = requireCode(t, err, apperr.CodeInvalidCredentials)

	assert.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM sessions`))
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM audit_logs WHERE action = 'staff.login_failed' AND entity_id = $1 AND actor_type = 'SYSTEM'`, ops.ID))
}

func TestLoginUnknownUsername(t *testing.T) {
	svc, _, pool := newTestService(t)

	_, _, err := svc.Login(context.Background(), "nobody", "whatever-123", testMeta)
	_ = requireCode(t, err, apperr.CodeInvalidCredentials)
	assert.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM audit_logs`))
}

func TestLoginLocksAfterFiveFailures(t *testing.T) {
	svc, clock, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		_, _, err := svc.Login(ctx, "ops.chan", "wrong-password", testMeta)
		_ = requireCode(t, err, apperr.CodeInvalidCredentials)
	}
	_, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	_ = requireCode(t, err, apperr.CodeAccountLocked)

	clock.Advance(15*time.Minute + time.Second)
	_, _, err = svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
}

func TestLoginRateLimitedByIP(t *testing.T) {
	svc, _, _ := newTestService(t)
	ctx := context.Background()

	for i := 0; i < 20; i++ {
		_, _, err := svc.Login(ctx, fmt.Sprintf("user%02d", i), "whatever-123", testMeta)
		_ = requireCode(t, err, apperr.CodeInvalidCredentials)
	}
	_, _, err := svc.Login(ctx, "user20", "whatever-123", testMeta)
	_ = requireCode(t, err, apperr.CodeRateLimited)
}

func TestAuthenticateSlidingExpiry(t *testing.T) {
	svc, clock, pool := newTestService(t)
	ops := createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
	loginAt := clock.Now()

	clock.Advance(30 * time.Second)
	staff, err := svc.Authenticate(ctx, token)
	require.NoError(t, err)
	assert.Equal(t, ops, staff)
	assert.True(t, sessionExpiry(t, pool).Equal(loginAt.Add(IdleTimeout)), "no write within TouchInterval")

	clock.Advance(90 * time.Second)
	_, err = svc.Authenticate(ctx, token)
	require.NoError(t, err)
	assert.True(t, sessionExpiry(t, pool).Equal(clock.Now().Add(IdleTimeout)), "extended after TouchInterval")
}

func TestAuthenticateIdleTimeout(t *testing.T) {
	svc, clock, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	clock.Advance(IdleTimeout + time.Second)
	_, err = svc.Authenticate(ctx, token)
	_ = requireCode(t, err, apperr.CodeUnauthenticated)
}

func TestAuthenticateAbsoluteTimeout(t *testing.T) {
	svc, clock, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	// 每 7 小时活动一次，空闲从不超时；23 次后到达 161 小时。
	for i := 0; i < 23; i++ {
		clock.Advance(7 * time.Hour)
		_, err := svc.Authenticate(ctx, token)
		require.NoError(t, err, "hour %d", (i+1)*7)
	}
	clock.Advance(7 * time.Hour) // 168 小时 = 绝对过期时刻
	_, err = svc.Authenticate(ctx, token)
	_ = requireCode(t, err, apperr.CodeUnauthenticated)
}

func TestAuthenticateRejectsGarbageToken(t *testing.T) {
	svc, _, _ := newTestService(t)
	_, err := svc.Authenticate(context.Background(), "not-a-token")
	_ = requireCode(t, err, apperr.CodeUnauthenticated)
}

func TestLogoutRevokesSession(t *testing.T) {
	svc, _, _ := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()
	token, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	require.NoError(t, svc.Logout(ctx, token))
	_, err = svc.Authenticate(ctx, token)
	_ = requireCode(t, err, apperr.CodeUnauthenticated)

	assert.NoError(t, svc.Logout(ctx, "garbage"))
}

func TestDeleteExpiredSessions(t *testing.T) {
	svc, clock, pool := newTestService(t)
	createOps(t, svc)
	ctx := context.Background()

	tokenA, _, err := svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
	_, _, err = svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)
	require.NoError(t, svc.Logout(ctx, tokenA))

	clock.Advance(7*24*time.Hour + 9*time.Hour)
	_, _, err = svc.Login(ctx, "ops.chan", "correct-horse-1", testMeta)
	require.NoError(t, err)

	deleted, err := svc.DeleteExpiredSessions(ctx, 7*24*time.Hour)
	require.NoError(t, err)
	assert.Equal(t, int64(2), deleted, "revoked A and idle-expired B")
	assert.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM sessions`))
}
