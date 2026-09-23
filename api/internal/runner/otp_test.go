package runner_test

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/runner"
)

// fakeSender 记录最近一次发送的验证码；err 非空时返回它。
type fakeSender struct {
	mu    sync.Mutex
	codes map[string]string
	err   error
}

func (f *fakeSender) Send(_ context.Context, phone, code string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return "", f.err
	}
	if f.codes == nil {
		f.codes = map[string]string{}
	}
	f.codes[phone] = code
	return "req-" + code, nil
}

func (f *fakeSender) last(phone string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.codes[phone]
}

const phoneA = "+85512345678"

func TestRequestPhoneCodeRejectsBadPhone(t *testing.T) {
	f := newFixture(t)
	_, err := f.svc.RequestPhoneCode(context.Background(), "012345678", testMeta)
	requireAppError(t, err, http.StatusUnprocessableEntity, apperr.CodeOTPPhoneInvalid)
}

func TestRequestPhoneCodeStoresHashAndInvalidatesOld(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	res, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)
	assert.Equal(t, 5*time.Minute, res.ExpiresIn)
	assert.Equal(t, 60*time.Second, res.ResendAfter)
	first := f.sender.last(phoneA)
	require.Len(t, first, 6)

	f.clock.t = f.clock.t.Add(61 * time.Second)
	_, err = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)
	assert.Equal(t, 1, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE phone_e164=$1 AND consumed_at IS NULL", phoneA))
	assert.Equal(t, 2, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE phone_e164=$1", phoneA))
	assert.Equal(t, 2, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE provider_request_id LIKE 'req-%'"), "两条都应带 request_id")
}

func TestRequestPhoneCodeCooldown(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)

	_, err = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)

	requireAppError(t, err, http.StatusTooManyRequests, apperr.CodeRateLimited)
	appErr, _ := apperr.As(err)
	assert.Equal(t, "60", appErr.Fields["retryAfterSeconds"].Key)
}

func TestRequestPhoneCodeSendFailures(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"号码不可达", runner.ErrPhoneUnreachable, 422, apperr.CodeOTPPhoneNotOnTelegram},
		{"通道故障", errors.New("boom"), 502, apperr.CodeOTPSendFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.sender.err = tc.err
			_, err := f.svc.RequestPhoneCode(context.Background(), phoneA, testMeta)
			requireAppError(t, err, tc.status, tc.code)
			assert.Equal(t, 0, countRows(t, f.pool, "SELECT count(*) FROM auth_otps WHERE phone_e164=$1 AND consumed_at IS NULL", phoneA), "发送失败的验证码必须作废")
		})
	}
}

func TestVerifyPhoneCodeHappyPath(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)

	sess, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "km", testMeta)

	require.NoError(t, err)
	assert.Equal(t, phoneA, sess.User.Phone)
	assert.Zero(t, sess.User.TelegramUserID)
	assert.Equal(t, "km", sess.User.Locale)
	assert.Equal(t, f.clock.t.Add(runner.SessionTTL), sess.ExpiresAt)
	u, err := f.svc.Authenticate(ctx, sess.Token)
	require.NoError(t, err)
	assert.Equal(t, sess.User.ID, u.ID)
	assert.Equal(t, 1, countRows(t, f.pool, "SELECT count(*) FROM audit_logs WHERE action='runner.login' AND entity_id=$1", u.ID))

	// 同一验证码不能用第二次
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "km", testMeta)
	requireAppError(t, err, 422, apperr.CodeOTPExpired)
}

func TestVerifyPhoneCodeSecondLoginKeepsLocale(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	first, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "km", testMeta)
	require.NoError(t, err)

	f.clock.t = f.clock.t.Add(2 * time.Minute)
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	second, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "en", testMeta)

	require.NoError(t, err)
	assert.Equal(t, first.User.ID, second.User.ID)
	assert.Equal(t, "km", second.User.Locale, "再次登录不覆盖 locale")
}

func TestVerifyPhoneCodeWrongAndExceeded(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)

	for i := 4; i >= 1; i-- {
		_, err := f.svc.VerifyPhoneCode(ctx, phoneA, "000000", "zh", testMeta)
		requireAppError(t, err, 422, apperr.CodeOTPInvalid)
		appErr, _ := apperr.As(err)
		assert.Equal(t, string(rune('0'+i)), appErr.Fields["attemptsLeft"].Key)
	}
	_, err := f.svc.VerifyPhoneCode(ctx, phoneA, "000000", "zh", testMeta)
	requireAppError(t, err, 422, apperr.CodeOTPInvalid)
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	requireAppError(t, err, 422, apperr.CodeOTPAttemptsExceeded)
}

func TestVerifyPhoneCodeExpired(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	f.clock.t = f.clock.t.Add(5*time.Minute + time.Second)

	_, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)

	requireAppError(t, err, 422, apperr.CodeOTPExpired)
}

func TestVerifyPhoneCodeCanonicalizesLocale(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)

	sess, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh-CN", testMeta)

	require.NoError(t, err)
	assert.Equal(t, "zh", sess.User.Locale)
	var stored string
	require.NoError(t, f.pool.QueryRow(ctx, "SELECT locale FROM users WHERE id=$1", sess.User.ID).Scan(&stored))
	assert.Equal(t, "zh", stored, "存库前必须先规范化，否则 CHECK 约束会拒绝 zh-CN")
}

func TestVerifyPhoneCodeDisabledUser(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	_, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, "UPDATE users SET status='DISABLED' WHERE phone_e164=$1", phoneA)
	require.NoError(t, err)

	f.clock.t = f.clock.t.Add(2 * time.Minute)
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)

	requireAppError(t, err, http.StatusForbidden, apperr.CodeForbidden)
}

func TestUpdateMe(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	sess, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	require.NoError(t, err)

	name := "Sok Dara"
	lang := "en"
	u, err := f.svc.UpdateMe(ctx, sess.User.ID, &name, &lang, testMeta)
	require.NoError(t, err)
	assert.Equal(t, "Sok Dara", u.DisplayName)
	assert.Equal(t, "en", u.Locale)

	tooLong := string(make([]rune, 65))
	_, err = f.svc.UpdateMe(ctx, sess.User.ID, &tooLong, nil, testMeta)
	requireAppError(t, err, 422, apperr.CodeValidation)
	bad := "fr"
	_, err = f.svc.UpdateMe(ctx, sess.User.ID, nil, &bad, testMeta)
	requireAppError(t, err, 422, apperr.CodeValidation)
}

func TestUpdateMeCanonicalizesLocale(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_, _ = f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	sess, err := f.svc.VerifyPhoneCode(ctx, phoneA, f.sender.last(phoneA), "zh", testMeta)
	require.NoError(t, err)

	locale := "zh-CN"
	u, err := f.svc.UpdateMe(ctx, sess.User.ID, nil, &locale, testMeta)

	require.NoError(t, err)
	assert.Equal(t, "zh", u.Locale)
	var stored string
	require.NoError(t, f.pool.QueryRow(ctx, "SELECT locale FROM users WHERE id=$1", sess.User.ID).Scan(&stored))
	assert.Equal(t, "zh", stored, "存库前必须先规范化，否则 CHECK 约束会拒绝 zh-CN")
}

func TestFixedSenderUsesFixedCode(t *testing.T) {
	f := newFixtureWithSender(t, runner.FixedOTPSender{})
	ctx := context.Background()
	_, err := f.svc.RequestPhoneCode(ctx, phoneA, testMeta)
	require.NoError(t, err)
	_, err = f.svc.VerifyPhoneCode(ctx, phoneA, runner.FixedOTPCode, "zh", testMeta)
	require.NoError(t, err)
}
