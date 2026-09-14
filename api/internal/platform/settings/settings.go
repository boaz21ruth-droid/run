// Package settings 读取 system_settings 中的运行参数。
package settings

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// identOffsetHardMax 是识别分的代码上限，数据库配置不能突破。
const identOffsetHardMax = 50

// Payment 是付款相关期限。
type Payment struct {
	UploadWindow        time.Duration
	ReuploadWindow      time.Duration
	ReviewSLA           time.Duration
	IdentOffsetMaxCents int64 // 已与 50 取最小值
}

// LoadPayment 读取付款期限；缺行或值不大于 0 时用默认值（30 分钟、24 小时、24 小时、50 分）。
// q 可以是连接池或事务。
func LoadPayment(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (Payment, error) {
	upload, err := intSetting(ctx, q, "payment.upload_window_minutes", 30)
	if err != nil {
		return Payment{}, err
	}
	reupload, err := intSetting(ctx, q, "payment.reupload_window_hours", 24)
	if err != nil {
		return Payment{}, err
	}
	sla, err := intSetting(ctx, q, "payment.review_sla_hours", 24)
	if err != nil {
		return Payment{}, err
	}
	offset, err := intSetting(ctx, q, "payment.ident_offset_max_cents", identOffsetHardMax)
	if err != nil {
		return Payment{}, err
	}
	return Payment{
		UploadWindow:        time.Duration(upload) * time.Minute,
		ReuploadWindow:      time.Duration(reupload) * time.Hour,
		ReviewSLA:           time.Duration(sla) * time.Hour,
		IdentOffsetMaxCents: min(offset, identOffsetHardMax),
	}, nil
}

// intSetting 读取一个整数设置；jsonb 的数字与数字字符串（'45'、'"45"'）都接受。
func intSetting(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, key string, def int64) (int64, error) {
	var v int64
	err := q.QueryRow(ctx, `SELECT (value #>> '{}')::bigint FROM system_settings WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return def, nil
	}
	if err != nil {
		return 0, fmt.Errorf("settings: read %s: %w", key, err)
	}
	if v <= 0 {
		return def, nil
	}
	return v, nil
}
