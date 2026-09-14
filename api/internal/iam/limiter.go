package iam

import (
	"sync"
	"time"
)

// Clock 返回当前时间；生产用 time.Now，测试注入假时钟。
type Clock func() time.Time

// 限流参数取自 spec §5.4。
const (
	ipWindow      = time.Minute
	ipMaxAttempts = 20
	failureWindow = 15 * time.Minute
	maxFailures   = 5
	lockDuration  = 15 * time.Minute
)

// LoginLimiter 在内存里计数（一期单实例部署）。
type LoginLimiter struct {
	mu       sync.Mutex
	clock    Clock
	ipHits   map[string][]time.Time
	failures map[string][]time.Time
	locked   map[string]time.Time
}

func NewLoginLimiter(clock Clock) *LoginLimiter {
	return &LoginLimiter{
		clock:    clock,
		ipHits:   map[string][]time.Time{},
		failures: map[string][]time.Time{},
		locked:   map[string]time.Time{},
	}
}

// AllowIP 记录一次登录尝试；同一 IP 最近一分钟内已有 20 次时返回 false 且不计数。
func (l *LoginLimiter) AllowIP(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	hits := pruneBefore(l.ipHits[ip], now.Add(-ipWindow))
	if len(hits) >= ipMaxAttempts {
		l.ipHits[ip] = hits
		return false
	}
	l.ipHits[ip] = append(hits, now)
	return true
}

// Locked 报告用户名当前是否处于锁定期。
func (l *LoginLimiter) Locked(username string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	until, ok := l.locked[username]
	if !ok {
		return false
	}
	if l.clock().Before(until) {
		return true
	}
	delete(l.locked, username)
	return false
}

// Failure 记录一次失败；15 分钟内累计第 5 次时锁定 15 分钟并清空计数。
func (l *LoginLimiter) Failure(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	failures := append(pruneBefore(l.failures[username], now.Add(-failureWindow)), now)
	if len(failures) >= maxFailures {
		l.locked[username] = now.Add(lockDuration)
		delete(l.failures, username)
		return
	}
	l.failures[username] = failures
}

// Success 清除该用户名的失败计数与锁定。
func (l *LoginLimiter) Success(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, username)
	delete(l.locked, username)
}

// pruneBefore 去掉不晚于 cutoff 的时间点（切片按时间递增）。
func pruneBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}
