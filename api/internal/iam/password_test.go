package iam

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)

	ok, err := VerifyPassword(hash, "correct-horse-1")
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestVerifyPasswordWrongPassword(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)

	ok, err := VerifyPassword(hash, "correct-horse-2")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestHashPasswordEncodesParameters(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=2$"), hash)

	other, err := HashPassword("correct-horse-1")
	require.NoError(t, err)
	assert.NotEqual(t, hash, other, "salt must be random")
}

// TestVerifyPasswordLimitedCapsConcurrency 证明 argon2Slots 真的限制了并发度：占满
// 全部名额后，再来一次校验必须在 argon2AcquireTimeout 左右放弃并返回 errArgon2Busy，
// 而不是无限排队去做一次 64MiB 的 argon2 计算。
func TestVerifyPasswordLimitedCapsConcurrency(t *testing.T) {
	prevTimeout := argon2AcquireTimeout
	argon2AcquireTimeout = 50 * time.Millisecond
	t.Cleanup(func() { argon2AcquireTimeout = prevTimeout })

	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)

	for i := 0; i < argon2MaxConcurrent; i++ {
		argon2Slots <- struct{}{}
	}
	t.Cleanup(func() {
		for i := 0; i < argon2MaxConcurrent; i++ {
			<-argon2Slots
		}
	})

	start := time.Now()
	_, err = verifyPasswordLimited(context.Background(), hash, "correct-horse-1")
	elapsed := time.Since(start)

	assert.ErrorIs(t, err, errArgon2Busy)
	assert.GreaterOrEqual(t, elapsed, argon2AcquireTimeout, "must actually wait for the timeout, not fail immediately")
	assert.Less(t, elapsed, time.Second, "must not wait much longer than the configured timeout")
}

// TestVerifyPasswordLimitedAllowsUpToCap 证明名额没占满时，最多 argon2MaxConcurrent
// 个并发校验都能正常放行并得到正确结果。
func TestVerifyPasswordLimitedAllowsUpToCap(t *testing.T) {
	hash, err := HashPassword("correct-horse-1")
	require.NoError(t, err)

	var wg sync.WaitGroup
	results := make(chan bool, argon2MaxConcurrent)
	for i := 0; i < argon2MaxConcurrent; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := verifyPasswordLimited(context.Background(), hash, "correct-horse-1")
			assert.NoError(t, err)
			results <- ok
		}()
	}
	wg.Wait()
	close(results)
	for ok := range results {
		assert.True(t, ok)
	}
}

func TestVerifyPasswordMalformedHash(t *testing.T) {
	for _, bad := range []string{
		"",
		"plain-text",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=18$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=x,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$!!!$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$",
	} {
		ok, err := VerifyPassword(bad, "anything")
		assert.ErrorIs(t, err, ErrMalformedHash, bad)
		assert.False(t, ok)
	}
}
