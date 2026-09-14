package iam

import (
	"strings"
	"testing"

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
