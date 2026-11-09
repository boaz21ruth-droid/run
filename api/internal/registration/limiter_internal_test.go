package registration

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestQuoteLimiterPerUser(t *testing.T) {
	now := time.Date(2026, 10, 28, 3, 0, 0, 0, time.UTC)
	l := newQuoteLimiter(func() time.Time { return now })

	for i := range quoteUserMax {
		_, ok := l.Allow(1, "203.0.113.1")
		require.True(t, ok, "第 %d 次", i+1)
	}
	wait, ok := l.Allow(1, "203.0.113.1")
	assert.False(t, ok)
	assert.Equal(t, quoteWindow, wait)

	_, ok = l.Allow(1, "203.0.113.2")
	assert.False(t, ok, "换 IP 不能绕过跑者配额")
	_, ok = l.Allow(2, "203.0.113.1")
	assert.True(t, ok, "别的跑者不受影响")

	now = now.Add(quoteWindow)
	_, ok = l.Allow(1, "203.0.113.1")
	assert.True(t, ok, "窗口过去后恢复")
}

func TestQuoteLimiterPerIP(t *testing.T) {
	now := time.Date(2026, 10, 28, 3, 0, 0, 0, time.UTC)
	l := newQuoteLimiter(func() time.Time { return now })

	for i := range quoteIPMax {
		_, ok := l.Allow(int64(i), "203.0.113.9")
		require.True(t, ok, "第 %d 次", i+1)
	}
	now = now.Add(90 * time.Second)
	wait, ok := l.Allow(9999, "203.0.113.9")
	assert.False(t, ok, "同一 IP 换跑者也受 IP 配额限制")
	assert.Equal(t, quoteWindow-90*time.Second, wait)
	_, ok = l.Allow(9999, "203.0.113.10")
	assert.True(t, ok)
}
