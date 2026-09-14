package iam

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// argon2id 参数取自 spec §5.4。
const (
	argonTime    uint32 = 3
	argonMemory  uint32 = 64 * 1024 // KiB，即 64MB
	argonThreads uint8  = 2
	argonSaltLen        = 16
	argonKeyLen  uint32 = 32
)

// ErrMalformedHash 表示库里存的密码哈希不是本包生成的格式。
var ErrMalformedHash = errors.New("iam: malformed password hash")

// argon2MaxConcurrent 限制同时执行中的 argon2 哈希/校验次数。argon2id 按上面的参数
// 每次分配 64MiB 内存（且耗 CPU）；如果不设上限，攻击者只需要并发发起登录请求——哪怕
// 用户名不存在、密码错误，Login 都会做一次等开销的 argon2 计算——就能把内存/CPU 开销
// 放大成事实上的 DoS。这是一个包级全局信号量而不是挂在 Service 上：argon2 的开销是整
// 个进程共享的资源，理应有一个进程级的上限。
const argon2MaxConcurrent = 4

var argon2Slots = make(chan struct{}, argon2MaxConcurrent)

// argon2AcquireTimeout 是等待一个空闲名额的最长时间。是变量而不是常量，方便测试注入
// 更短的等待，不用真的等 2 秒。
var argon2AcquireTimeout = 2 * time.Second

// errArgon2Busy 表示在 argon2AcquireTimeout 内没有等到空闲名额。
var errArgon2Busy = errors.New("iam: no argon2 slot available")

// verifyPasswordLimited 在 argon2Slots 允许的并发度下执行一次 VerifyPassword；等不到
// 名额时返回 errArgon2Busy，调用方（Login）应把它转成 429 RATE_LIMITED 立即拒绝，而
// 不是让请求排队等到客户端或反向代理超时。
func verifyPasswordLimited(ctx context.Context, encoded, password string) (bool, error) {
	timer := time.NewTimer(argon2AcquireTimeout)
	defer timer.Stop()
	select {
	case argon2Slots <- struct{}{}:
	case <-timer.C:
		return false, errArgon2Busy
	case <-ctx.Done():
		return false, errArgon2Busy
	}
	defer func() { <-argon2Slots }()
	return VerifyPassword(encoded, password)
}

// HashPassword 返回 PHC 格式字符串：$argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>。
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("iam: generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword 按哈希里记录的参数重新计算并做常量时间比较。
func VerifyPassword(encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false, ErrMalformedHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, ErrMalformedHash
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false, ErrMalformedHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) == 0 {
		return false, ErrMalformedHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, ErrMalformedHash
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
