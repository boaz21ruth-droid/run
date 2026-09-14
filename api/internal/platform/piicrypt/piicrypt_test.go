package piicrypt_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/piicrypt"
)

var testKey = []byte("dev-only-pii-key-32-bytes-000000")

func newCipher(t *testing.T) *piicrypt.Cipher {
	t.Helper()
	c, err := piicrypt.New(testKey)
	require.NoError(t, err)
	return c
}

func TestNewRejectsWrongKeyLength(t *testing.T) {
	_, err := piicrypt.New(testKey[:31])
	require.Error(t, err)
	_, err = piicrypt.New(append(bytes.Clone(testKey), 'x'))
	require.Error(t, err)
}

func TestNormalizeIDNo(t *testing.T) {
	cases := map[string]string{
		"n 123-456 789": "N123456789",
		"\tab-12 cd ":   "AB12CD",
		"E1234567":      "E1234567",
		"":              "",
	}
	for in, want := range cases {
		assert.Equal(t, want, piicrypt.NormalizeIDNo(in), "%q", in)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	c := newCipher(t)

	first, err := c.Encrypt("N123456789")
	require.NoError(t, err)
	second, err := c.Encrypt("N123456789")
	require.NoError(t, err)

	assert.NotEqual(t, first, second, "随机 nonce：同一明文两次加密结果不同")
	assert.Len(t, first, 12+len("N123456789")+16, "12 字节 nonce + 密文 + 16 字节 GCM 标签")
	plain, err := c.Decrypt(first)
	require.NoError(t, err)
	assert.Equal(t, "N123456789", plain)
}

func TestDecryptRejectsTamperedOrShortInput(t *testing.T) {
	c := newCipher(t)
	sealed, err := c.Encrypt("N123456789")
	require.NoError(t, err)

	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 0x01
	_, err = c.Decrypt(tampered)
	require.Error(t, err)

	_, err = c.Decrypt(sealed[:10])
	require.Error(t, err)

	other, err := piicrypt.New([]byte("another-pii-key-32-bytes-0000000"))
	require.NoError(t, err)
	_, err = other.Decrypt(sealed)
	require.Error(t, err)
}

func TestHashUsesDerivedHMACKey(t *testing.T) {
	c := newCipher(t)

	derive := sha256.New()
	derive.Write([]byte("werun/pii-hash/v1"))
	derive.Write(testKey)
	mac := hmac.New(sha256.New, derive.Sum(nil))
	mac.Write([]byte("N123456789"))

	got := c.Hash("N123456789")

	assert.Len(t, got, 32)
	assert.Equal(t, mac.Sum(nil), got)
	assert.Equal(t, got, c.Hash("N123456789"), "同一输入哈希稳定")
	assert.NotEqual(t, got, c.Hash("N123456788"))
}

func TestMaskIDNo(t *testing.T) {
	assert.Equal(t, "******6789", piicrypt.MaskIDNo("N123456789"))
	assert.Equal(t, "********1234", piicrypt.MaskIDNo("AB1234561234"))
	assert.Equal(t, "*1234", piicrypt.MaskIDNo("A1234"))
	assert.Equal(t, "****", piicrypt.MaskIDNo("1234"))
	assert.Equal(t, "**", piicrypt.MaskIDNo("12"))
	assert.Equal(t, "", piicrypt.MaskIDNo(""))
}
