package registration

import (
	"sync"
	"time"
)

// 算价预览限流参数。每次预览都会查价格档、优惠码等多张表，并可用来批量试探优惠码，
// 所以按跑者与 IP 各设一个滑动窗口。IP 上限放宽：柬埔寨移动网络普遍走运营商级 NAT，大量跑者共用出口 IP。
const (
	quoteWindow     = 10 * time.Minute
	quoteUserMax    = 30
	quoteIPMax      = 300
	quoteSweepEvery = 64
)

// quoteLimiter 在内存里按跑者与 IP 计数（单实例部署，重启清零），写法与 runner.OTPLimiter 一致。
type quoteLimiter struct {
	mu    sync.Mutex
	clock func() time.Time
	user  map[int64][]time.Time
	ip    map[string][]time.Time
	calls uint64
}

func newQuoteLimiter(clock func() time.Time) *quoteLimiter {
	return &quoteLimiter{clock: clock, user: map[int64][]time.Time{}, ip: map[string][]time.Time{}}
}

// Allow 判断 userID 从 ip 是否还能再预览一次并记一次；被拒时返回最早可再试的等待时长（向上取整到秒）。
// 被拒的请求不计数。
func (l *quoteLimiter) Allow(userID int64, ip string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.maybeSweep(now)
	cutoff := now.Add(-quoteWindow)

	ipHits := pruneHits(l.ip[ip], cutoff)
	if len(ipHits) >= quoteIPMax {
		l.ip[ip] = ipHits
		return ceilSeconds(ipHits[0].Add(quoteWindow).Sub(now)), false
	}
	userHits := pruneHits(l.user[userID], cutoff)
	if len(userHits) >= quoteUserMax {
		l.user[userID] = userHits
		return ceilSeconds(userHits[0].Add(quoteWindow).Sub(now)), false
	}
	l.ip[ip] = append(ipHits, now)
	l.user[userID] = append(userHits, now)
	return 0, true
}

func (l *quoteLimiter) maybeSweep(now time.Time) {
	l.calls++
	if l.calls%quoteSweepEvery != 0 {
		return
	}
	cutoff := now.Add(-quoteWindow)
	for k, ts := range l.ip {
		if ts = pruneHits(ts, cutoff); len(ts) == 0 {
			delete(l.ip, k)
		} else {
			l.ip[k] = ts
		}
	}
	for k, ts := range l.user {
		if ts = pruneHits(ts, cutoff); len(ts) == 0 {
			delete(l.user, k)
		} else {
			l.user[k] = ts
		}
	}
}

// pruneHits 去掉不晚于 cutoff 的时间点（ts 按时间升序）。
func pruneHits(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}

func ceilSeconds(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return ((d + time.Second - 1) / time.Second) * time.Second
}
