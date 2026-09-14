package storage

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// NewKey 生成 "yyyy/mm/<32 位小写十六进制>.<ext>"，年月取 UTC。
func NewKey(now time.Time, ext string) string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误
	u := now.UTC()
	return fmt.Sprintf("%04d/%02d/%s.%s", u.Year(), int(u.Month()), hex.EncodeToString(b[:]), ext)
}
