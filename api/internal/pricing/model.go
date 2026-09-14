// Package pricing 是价格与优惠模块：价格档、优惠码的后台维护，以及下单算价（Task 11 起）。
package pricing

import (
	"time"

	"werun/api/internal/platform/i18n"
)

// price_rules.audience 的取值。
const (
	AudienceAll   = "ALL"
	AudienceLocal = "LOCAL"
)

// PriceRuleInput 是后台新建或修改价格档的输入。
type PriceRuleInput struct {
	Name         i18n.Text
	Audience     string
	PriceCents   int64
	Quota        *int32 // nil = 不限
	SaleStartsAt *time.Time
	SaleEndsAt   *time.Time
	SortOrder    int16
	CategoryIDs  []int64
}

// PriceRule 是价格档及其计数。
type PriceRule struct {
	ID, EventID   int64
	Input         PriceRuleInput
	UsedCount     int32
	ReservedCount int32
}

// coupons.discount_type 与 coupons.status 的取值。
const (
	DiscountPercent = "PERCENT"
	DiscountAmount  = "AMOUNT"
	DiscountWaiver  = "WAIVER"

	CouponActive   = "ACTIVE"
	CouponDisabled = "DISABLED"
)

// CouponInput 是后台新建或修改优惠码的输入。DiscountValue：PERCENT 为 1–100，AMOUNT 为分，WAIVER 为 0。
type CouponInput struct {
	Code          string
	EventID       *int64 // nil = 全场通用
	DiscountType  string
	DiscountValue int64
	Quota         int32
	MinRunners    *int16
	ValidFrom     *time.Time
	ValidUntil    *time.Time
	Description   i18n.Text // 可为 nil
	Status        string    // ACTIVE | DISABLED
}

// Coupon 是优惠码及其计数。
type Coupon struct {
	ID            int64
	Input         CouponInput
	UsedCount     int32
	ReservedCount int32
}
