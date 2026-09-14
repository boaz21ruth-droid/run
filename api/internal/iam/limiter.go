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

	// sweepEvery 控制机会式清理的频率：每 sweepEvery 次对限流器的调用，
	// 顺带清理一遍所有 map 里已经过期、且没有再被访问的 key。
	// 这样攻击者用一次性的用户名/IP 发起请求也不会让 map 无限增长。
	sweepEvery = 64
)

// LoginLimiter 在内存里计数（一期单实例部署）。
type LoginLimiter struct {
	mu       sync.Mutex
	clock    Clock
	ipHits   map[string][]time.Time
	failures map[string][]time.Time
	locked   map[string]time.Time
	inFlight map[string]int // BeginAttempt 已放行、尚未 Failure/Success/Release 的请求数
	calls    uint64
}

func NewLoginLimiter(clock Clock) *LoginLimiter {
	return &LoginLimiter{
		clock:    clock,
		ipHits:   map[string][]time.Time{},
		failures: map[string][]time.Time{},
		locked:   map[string]time.Time{},
		inFlight: map[string]int{},
	}
}

// AllowIP 记录一次登录尝试；同一 IP 最近一分钟内已有 20 次时返回 false 且不计数。
func (l *LoginLimiter) AllowIP(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.maybeSweep(now)
	hits := pruneBefore(l.ipHits[ip], now.Add(-ipWindow))
	if len(hits) >= ipMaxAttempts {
		setTimes(l.ipHits, ip, hits)
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

// BeginAttempt 原子地检查并预占一次登录尝试：用户名处于锁定期，或“15 分钟内的失败
// 次数 + 当前并发中的尝试数”已达到 maxFailures 时返回 false（不预占）；否则预占一个
// 名额并返回 true。调用方必须在该次登录结束时恰好一次地调用 Failure、Success 或
// Release 释放这个名额——这是并发登录请求也无法绕过"连续失败 5 次锁定"的关键：
// 检查与预占在同一次加锁里完成，不会出现多个并发请求都读到"未锁定"的竞态窗口。
func (l *LoginLimiter) BeginAttempt(username string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.maybeSweep(now)

	if until, ok := l.locked[username]; ok {
		if now.Before(until) {
			return false
		}
		delete(l.locked, username)
	}

	failures := pruneBefore(l.failures[username], now.Add(-failureWindow))
	setTimes(l.failures, username, failures)
	if len(failures)+l.inFlight[username] >= maxFailures {
		return false
	}
	l.inFlight[username]++
	return true
}

// Failure 记录一次失败并释放 BeginAttempt 预占的名额；15 分钟内累计第 5 次时
// 锁定 15 分钟并清空计数。
func (l *LoginLimiter) Failure(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.releaseInFlight(username)
	now := l.clock()
	failures := append(pruneBefore(l.failures[username], now.Add(-failureWindow)), now)
	if len(failures) >= maxFailures {
		l.locked[username] = now.Add(lockDuration)
		delete(l.failures, username)
		return
	}
	l.failures[username] = failures
}

// Success 释放 BeginAttempt 预占的名额，并清除该用户名的失败计数与锁定。
func (l *LoginLimiter) Success(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.releaseInFlight(username)
	delete(l.failures, username)
	delete(l.locked, username)
}

// Release 释放 BeginAttempt 预占的名额，但不记为失败也不清除锁定/失败计数。
// 用于登录流程在判定成功/失败之前就出错退出的路径（如数据库错误），避免名额
// 永久泄漏导致该用户名之后被误判为"并发已满"。
func (l *LoginLimiter) Release(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.releaseInFlight(username)
}

func (l *LoginLimiter) releaseInFlight(username string) {
	n, ok := l.inFlight[username]
	if !ok {
		return
	}
	if n <= 1 {
		delete(l.inFlight, username)
		return
	}
	l.inFlight[username] = n - 1
}

// maybeSweep 每 sweepEvery 次调用清理一遍三个 map：去掉滑动窗口之外的 ipHits/
// failures 条目（及其整个 key），以及已过期的 locked 条目。只有被随后请求重新
// 触达的 key 才会被各方法自身的剪枝逻辑处理；一次性的 key（攻击者随机用户名/IP）
// 依赖这里的清理，否则会在 map 里永久存在，造成内存缓慢增长。
func (l *LoginLimiter) maybeSweep(now time.Time) {
	l.calls++
	if l.calls%sweepEvery != 0 {
		return
	}
	for ip, hits := range l.ipHits {
		setTimes(l.ipHits, ip, pruneBefore(hits, now.Add(-ipWindow)))
	}
	for username, fails := range l.failures {
		setTimes(l.failures, username, pruneBefore(fails, now.Add(-failureWindow)))
	}
	for username, until := range l.locked {
		if !now.Before(until) {
			delete(l.locked, username)
		}
	}
}

// setTimes 写回剪枝后的时间切片；切片为空时直接删除这个 key，而不是存一个空切片
// 占住 map 条目。
func setTimes(m map[string][]time.Time, key string, ts []time.Time) {
	if len(ts) == 0 {
		delete(m, key)
		return
	}
	m[key] = ts
}

// pruneBefore 去掉不晚于 cutoff 的时间点（切片按时间递增）。
func pruneBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	return ts[i:]
}
