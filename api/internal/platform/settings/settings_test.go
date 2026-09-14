package settings_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/settings"
)

func TestLoadPaymentReadsSeededDefaults(t *testing.T) {
	pool := dbtest.NewPool(t)

	p, err := settings.LoadPayment(context.Background(), pool)

	require.NoError(t, err)
	assert.Equal(t, settings.Payment{
		UploadWindow:        30 * time.Minute,
		ReuploadWindow:      24 * time.Hour,
		ReviewSLA:           24 * time.Hour,
		IdentOffsetMaxCents: 50,
	}, p)
}

func TestLoadPaymentHonoursChangesCapsOffsetAndFallsBack(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE system_settings SET value = '45' WHERE key = 'payment.upload_window_minutes'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE system_settings SET value = '"12"' WHERE key = 'payment.reupload_window_hours'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE system_settings SET value = '80' WHERE key = 'payment.ident_offset_max_cents'`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM system_settings WHERE key = 'payment.review_sla_hours'`)
	require.NoError(t, err)

	p, err := settings.LoadPayment(ctx, pool)

	require.NoError(t, err)
	assert.Equal(t, 45*time.Minute, p.UploadWindow)
	assert.Equal(t, 12*time.Hour, p.ReuploadWindow, "字符串形式的 JSON 数字同样可读")
	assert.Equal(t, 24*time.Hour, p.ReviewSLA, "缺行时用默认值")
	assert.Equal(t, int64(50), p.IdentOffsetMaxCents, "识别分上限不超过 50")
}

func TestLoadPaymentReturnsErrorOnGarbage(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `UPDATE system_settings SET value = '"thirty"' WHERE key = 'payment.upload_window_minutes'`)
	require.NoError(t, err)

	_, err = settings.LoadPayment(ctx, pool)

	require.ErrorContains(t, err, "payment.upload_window_minutes")
}
