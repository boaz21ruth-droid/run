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
