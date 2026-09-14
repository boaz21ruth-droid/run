package iam

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// fakeClock 供本包所有测试共用。
type fakeClock struct{ now time.Time }

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 13, 8, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) Now() time.Time          { return f.now }
func (f *fakeClock) Advance(d time.Duration) { f.now = f.now.Add(d) }

func TestAllowIPWindow(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 20; i++ {
		assert.True(t, l.AllowIP("203.0.113.7"), "attempt %d", i+1)
	}
	assert.False(t, l.AllowIP("203.0.113.7"), "21st attempt within a minute")
	assert.True(t, l.AllowIP("198.51.100.1"), "other IPs are independent")

	clock.Advance(61 * time.Second)
	assert.True(t, l.AllowIP("203.0.113.7"), "window slides after a minute")
}

func TestFailuresLockAccount(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	assert.False(t, l.Locked("ops.chan"))

	l.Failure("ops.chan")
	assert.True(t, l.Locked("ops.chan"))

	clock.Advance(15*time.Minute - time.Second)
	assert.True(t, l.Locked("ops.chan"))

	clock.Advance(2 * time.Second)
	assert.False(t, l.Locked("ops.chan"), "lock expires after 15 minutes")
}

func TestFailuresOutsideWindowDoNotCount(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	clock.Advance(16 * time.Minute)
	l.Failure("ops.chan")
	assert.False(t, l.Locked("ops.chan"))
}

func TestSuccessResetsFailures(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	l.Success("ops.chan")
	for i := 0; i < 4; i++ {
		l.Failure("ops.chan")
	}
	assert.False(t, l.Locked("ops.chan"))
}
