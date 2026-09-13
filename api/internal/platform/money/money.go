// Package money 提供以最小货币单位（分）表示的金额类型。
package money

import "fmt"

// Cents 是以分为单位的金额，数据库中对应 *_cents bigint 列。
type Cents int64

// String 以美元格式输出，例如 2193 → "$21.93"，-500 → "-$5.00"。
func (c Cents) String() string {
	sign := ""
	v := int64(c)
	if v < 0 {
		sign = "-"
		v = -v
	}
	return fmt.Sprintf("%s$%d.%02d", sign, v/100, v%100)
}
