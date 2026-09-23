package runner

import (
	"sync"
	"time"
)

// 限流参数取自 spec §2。
const (
	otpPhoneCooldown = 60 * time.Second
	otpPhoneWindow   = time.Hour
	otpPhoneMax      = 5
	otpIPWindow      = time.Hour
	otpIPMax         = 20
	otpSweepEvery    = 64
)

// OTPLimiter 在内存里按号码与 IP 计数（单实例部署，重启清零）。
type OTPLimiter struct {
	mu    sync.Mutex
	clock func() time.Time
	phone map[string][]time.Time
	ip    map[string][]time.Time
	calls uint64
}

func NewOTPLimiter(clock func() time.Time) *OTPLimiter {
	return &OTPLimiter{clock: clock, phone: map[string][]time.Time{}, ip: map[string][]time.Time{}}
}

// Allow 判断是否可以给 phone 发一条验证码并记一次；被拒时返回最早可再试的等待时长（向上取整到秒）。
func (l *OTPLimiter) Allow(phone, ip string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	l.maybeSweep(now)

	ipHits := pruneOTP(l.ip[ip], now.Add(-otpIPWindow))
	if len(ipHits) >= otpIPMax {
		l.ip[ip] = ipHits
		return ceilSeconds(ipHits[0].Add(otpIPWindow).Sub(now)), false
	}
	phoneHits := pruneOTP(l.phone[phone], now.Add(-otpPhoneWindow))
	if n := len(phoneHits); n > 0 {
		if wait := phoneHits[n-1].Add(otpPhoneCooldown).Sub(now); wait > 0 {
			l.phone[phone] = phoneHits
			return ceilSeconds(wait), false
		}
		if n >= otpPhoneMax {
			l.phone[phone] = phoneHits
			return ceilSeconds(phoneHits[0].Add(otpPhoneWindow).Sub(now)), false
		}
	}
	l.ip[ip] = append(ipHits, now)
	l.phone[phone] = append(phoneHits, now)
	return 0, true
}

func (l *OTPLimiter) maybeSweep(now time.Time) {
	l.calls++
	if l.calls%otpSweepEvery != 0 {
		return
	}
	for k, ts := range l.ip {
		if ts = pruneOTP(ts, now.Add(-otpIPWindow)); len(ts) == 0 {
			delete(l.ip, k)
		} else {
			l.ip[k] = ts
		}
	}
	for k, ts := range l.phone {
		if ts = pruneOTP(ts, now.Add(-otpPhoneWindow)); len(ts) == 0 {
			delete(l.phone, k)
		} else {
			l.phone[k] = ts
		}
	}
}

func pruneOTP(ts []time.Time, cutoff time.Time) []time.Time {
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
