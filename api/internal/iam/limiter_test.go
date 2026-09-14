package iam

import (
	"fmt"
	"sync"
	"sync/atomic"
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

// TestBeginAttemptSerializesConcurrentFailures 证明并发请求无法绕过"连续失败 5
// 次锁定 15 分钟"：20 个 goroutine 同时对同一用户名抢 BeginAttempt，检查与预占
// 在同一次加锁里完成，所以最终放行（随即记为失败）的尝试次数永远不会超过
// maxFailures——而不是每个 goroutine 各自查一遍 Locked()（都读到"未锁定"）、
// 再各自调用一次 Failure() 那种会让锁定形同虚设的写法。
func TestBeginAttemptSerializesConcurrentFailures(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	const attackers = 20
	var admitted atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < attackers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if l.BeginAttempt("ops.chan") {
				admitted.Add(1)
				l.Failure("ops.chan")
			}
		}()
	}
	close(start)
	wg.Wait()

	assert.LessOrEqual(t, int(admitted.Load()), maxFailures, "at most maxFailures attempts may ever be admitted")
	assert.True(t, l.Locked("ops.chan"), "the admitted failures must have locked the account")
}

// TestLimiterEvictsStaleKeys 证明攻击者用一次性的 IP/用户名也不会让限流器的内存
// 无限增长：窗口/锁定期过后，即使这些 key 再也没有被单独访问，机会式清理也会把
// 它们从 map 里删掉。直接读内部字段（白盒测试，同包）而不是调用 Locked/AllowIP，
// 避免这些方法自身对单个 key 的"顺手清理"掩盖了清理是否真的来自 sweep。
func TestLimiterEvictsStaleKeys(t *testing.T) {
	clock := newFakeClock()
	l := NewLoginLimiter(clock.Now)

	for i := 0; i < 50; i++ {
		l.AllowIP(fmt.Sprintf("203.0.113.%d", i))
	}
	for i := 0; i < 10; i++ {
		l.Failure(fmt.Sprintf("partial%02d", i)) // 1 次失败，不到锁定阈值
	}
	for i := 0; i < 10; i++ {
		username := fmt.Sprintf("locked%02d", i)
		for j := 0; j < maxFailures; j++ {
			l.Failure(username)
		}
	}

	assert.NotEmpty(t, l.ipHits)
	assert.NotEmpty(t, l.failures)
	assert.NotEmpty(t, l.locked)

	clock.Advance(lockDuration + time.Minute) // 同时越过 ipWindow 与 failureWindow

	// 用另一个、从未出现过的用户名驱动调用，触发机会式清理；不直接触碰上面的
	// 陈旧 key，证明是 sweep 清理的，不是各方法自身对单个 key 的剪枝。
	for i := 0; i < sweepEvery; i++ {
		if l.BeginAttempt("sweeper") {
			l.Success("sweeper")
		}
	}

	assert.Empty(t, l.ipHits, "stale ipHits keys must be swept")
	assert.Empty(t, l.failures, "stale failures keys must be swept")
	assert.Empty(t, l.locked, "expired locks must be swept")
}
