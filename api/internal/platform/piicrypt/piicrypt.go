// Package piicrypt 加密与哈希个人证件号：AES-256-GCM（随机 12 字节 nonce 前置）与 HMAC-SHA256。
package piicrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"unicode"
)

const hashKeyLabel = "werun/pii-hash/v1"

// Cipher 持有加密器与派生出的哈希密钥，可并发使用。
type Cipher struct {
	aead    cipher.AEAD
	hashKey []byte
}

// New 用 32 字节密钥（WERUN_PII_KEY 解码后）创建 Cipher。
// 哈希密钥 = SHA-256("werun/pii-hash/v1" || key)，与加密密钥分离。
func New(key []byte) (*Cipher, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("piicrypt: key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("piicrypt: new aes cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("piicrypt: new gcm: %w", err)
	}
	h := sha256.New()
	h.Write([]byte(hashKeyLabel))
	h.Write(key)
	return &Cipher{aead: aead, hashKey: h.Sum(nil)}, nil
}

// NormalizeIDNo 去掉所有空白与连字符并转大写。加密、哈希、打码都使用规范化后的值。
func NormalizeIDNo(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) || r == '-' {
			continue
		}
		b.WriteRune(unicode.ToUpper(r))
	}
	return b.String()
}

// Encrypt 返回 nonce || 密文 || GCM 标签。
func (c *Cipher) Encrypt(plain string) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("piicrypt: read nonce: %w", err)
	}
	return c.aead.Seal(nonce, nonce, []byte(plain), nil), nil
}

// Decrypt 解开 Encrypt 的输出；数据被篡改或密钥不同时返回错误。
func (c *Cipher) Decrypt(sealed []byte) (string, error) {
	n := c.aead.NonceSize()
	if len(sealed) < n+c.aead.Overhead() {
		return "", errors.New("piicrypt: sealed data too short")
	}
	plain, err := c.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return "", fmt.Errorf("piicrypt: decrypt: %w", err)
	}
	return string(plain), nil
}

// Hash 返回 32 字节 HMAC-SHA256，用于按证件号查重。参数应已规范化。
func (c *Cipher) Hash(normalized string) []byte {
	mac := hmac.New(sha256.New, c.hashKey)
	mac.Write([]byte(normalized))
	return mac.Sum(nil)
}

// MaskIDNo 只保留后 4 位，其余替换为 *；长度不超过 4 时全部为 *。
func MaskIDNo(normalized string) string {
	runes := []rune(normalized)
	if len(runes) <= 4 {
		return strings.Repeat("*", len(runes))
	}
	return strings.Repeat("*", len(runes)-4) + string(runes[len(runes)-4:])
}
