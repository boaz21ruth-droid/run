package runner_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/runner"
)

func TestOTPLimiterPhoneCooldown(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)

	_, ok := l.Allow("+85512345678", "203.0.113.1")
	assert.True(t, ok)

	wait, ok := l.Allow("+85512345678", "203.0.113.1")
	assert.False(t, ok, "60 秒内不能重发")
	assert.Equal(t, 60*time.Second, wait)

	clock.t = clock.t.Add(60 * time.Second)
	_, ok = l.Allow("+85512345678", "203.0.113.1")
	assert.True(t, ok)
}

func TestOTPLimiterPhoneHourlyCap(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)
	for i := 0; i < 5; i++ {
		_, ok := l.Allow("+85512345678", "203.0.113.1")
		assert.True(t, ok, "第 %d 条", i+1)
		clock.t = clock.t.Add(61 * time.Second)
	}
	wait, ok := l.Allow("+85512345678", "203.0.113.1")
	assert.False(t, ok, "一小时内第 6 条被拒")
	assert.Greater(t, wait, 50*time.Minute)
}

func TestOTPLimiterIPHourlyCap(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)
	for i := 0; i < 20; i++ {
		_, ok := l.Allow("+8551000"+string(rune('0'+i%10))+string(rune('0'+i/10)), "203.0.113.9")
		assert.True(t, ok, "第 %d 个号码", i+1)
	}
	_, ok := l.Allow("+85519999999", "203.0.113.9")
	assert.False(t, ok, "同 IP 一小时第 21 条被拒")
	_, ok = l.Allow("+85519999999", "203.0.113.10")
	assert.True(t, ok, "另一个 IP 不受影响")
}

func TestOTPLimiterVerifyIPCap(t *testing.T) {
	clock := &testClock{t: baseNow}
	l := runner.NewOTPLimiter(clock.Now)
	for i := 0; i < 30; i++ {
		_, ok := l.AllowVerify("203.0.113.7")
		assert.True(t, ok, "第 %d 次校验", i+1)
	}
	wait, ok := l.AllowVerify("203.0.113.7")
	assert.False(t, ok, "同 IP 10 分钟内第 31 次校验被拒")
	assert.Equal(t, 10*time.Minute, wait)

	_, ok = l.AllowVerify("203.0.113.8")
	assert.True(t, ok, "另一个 IP 不受影响")

	clock.t = clock.t.Add(10 * time.Minute)
	_, ok = l.AllowVerify("203.0.113.7")
	assert.True(t, ok, "窗口滑过后恢复")
}
