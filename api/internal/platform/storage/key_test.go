package storage_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/platform/storage"
)

func TestNewKeyUsesUTCYearMonthAndRandomHex(t *testing.T) {
	// 金边时间 10 月 1 日 03:00 = UTC 9 月 30 日 20:00
	now := time.Date(2026, 10, 1, 3, 0, 0, 0, time.FixedZone("ICT", 7*3600))

	key := storage.NewKey(now, "png")

	assert.Regexp(t, `^2026/09/[0-9a-f]{32}\.png$`, key)
	assert.NotEqual(t, key, storage.NewKey(now, "png"))
}
