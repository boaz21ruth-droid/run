package pricing_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/pricing"
)

func day(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func at(s string) *time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &t
}

func quota(n int32) *int32 { return &n }

func TestSelectTier(t *testing.T) {
	now := *at("2026-09-14T10:00:00Z")
	early := pricing.TierCandidate{PriceRuleID: 1, Audience: "ALL", PriceCents: 2000, Quota: quota(2), SaleEndsAt: at("2026-10-01T00:00:00Z")}
	standard := pricing.TierCandidate{PriceRuleID: 2, Audience: "ALL", PriceCents: 3000}
	local := pricing.TierCandidate{PriceRuleID: 3, Audience: "LOCAL", PriceCents: 1500}

	cases := []struct {
		name     string
		cands    []pricing.TierCandidate
		nat      string
		taken    map[int64]int
		wantID   int64
		wantFind bool
	}{
		{"本地人取最便宜的本地价", []pricing.TierCandidate{early, standard, local}, "KH", nil, 3, true},
		{"外国人不能用本地价", []pricing.TierCandidate{early, standard, local}, "US", nil, 1, true},
		{"未开售的档跳过", []pricing.TierCandidate{{PriceRuleID: 4, Audience: "ALL", PriceCents: 100, SaleStartsAt: at("2026-09-15T00:00:00Z")}, standard}, "US", nil, 2, true},
		{"开售时间等于现在可以买", []pricing.TierCandidate{{PriceRuleID: 4, Audience: "ALL", PriceCents: 100, SaleStartsAt: at("2026-09-14T10:00:00Z")}, standard}, "US", nil, 4, true},
		{"截止时间等于现在不能买", []pricing.TierCandidate{{PriceRuleID: 4, Audience: "ALL", PriceCents: 100, SaleEndsAt: at("2026-09-14T10:00:00Z")}, standard}, "US", nil, 2, true},
		{"配额被占满跳过", []pricing.TierCandidate{{PriceRuleID: 1, Audience: "ALL", PriceCents: 2000, Quota: quota(2), UsedCount: 1, ReservedCount: 1}, standard}, "US", nil, 2, true},
		{"本单已选人数计入配额", []pricing.TierCandidate{early, standard}, "US", map[int64]int{1: 2}, 2, true},
		{"本单已选但配额仍有余", []pricing.TierCandidate{early, standard}, "US", map[int64]int{1: 1}, 1, true},
		{"同价取 sort_order 小的", []pricing.TierCandidate{{PriceRuleID: 5, Audience: "ALL", PriceCents: 3000, SortOrder: 2}, {PriceRuleID: 6, Audience: "ALL", PriceCents: 3000, SortOrder: 1}}, "US", nil, 6, true},
		{"同价同序取 id 小的", []pricing.TierCandidate{{PriceRuleID: 8, Audience: "ALL", PriceCents: 3000}, {PriceRuleID: 7, Audience: "ALL", PriceCents: 3000}}, "US", nil, 7, true},
		{"没有候选", []pricing.TierCandidate{local}, "US", nil, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := pricing.SelectTier(tc.cands, tc.nat, now, tc.taken)
			require.Equal(t, tc.wantFind, ok)
			require.Equal(t, tc.wantID, got.PriceRuleID)
		})
	}
}

func TestAgeOn(t *testing.T) {
	cases := []struct {
		name  string
		birth string
		race  string
		want  int
	}{
		{"比赛当天生日满岁", "2010-11-15", "2026-11-15", 16},
		{"比赛前一天还差一天", "2010-11-16", "2026-11-15", 15},
		{"2 月 29 日出生，非闰年 2 月 28 日未满岁", "2008-02-29", "2026-02-28", 17},
		{"2 月 29 日出生，非闰年 3 月 1 日满岁", "2008-02-29", "2026-03-01", 18},
		{"2 月 29 日出生，闰年 2 月 29 日满岁", "2008-02-29", "2028-02-29", 20},
		{"2 月 29 日出生，闰年 2 月 28 日未满岁", "2008-02-29", "2028-02-28", 19},
		{"刚好等于最低年龄", "2008-11-15", "2026-11-15", 18},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, pricing.AgeOn(day(tc.birth), day(tc.race)))
		})
	}
}

func TestCouponDiscount(t *testing.T) {
	cases := []struct {
		name string
		rule pricing.CouponRule
		list int64
		want int64
	}{
		{"百分比向下取整", pricing.CouponRule{DiscountType: "PERCENT", DiscountValue: 15}, 3333, 499},
		{"百分比 100", pricing.CouponRule{DiscountType: "PERCENT", DiscountValue: 100}, 5000, 5000},
		{"固定金额小于原价", pricing.CouponRule{DiscountType: "AMOUNT", DiscountValue: 500}, 5000, 500},
		{"固定金额超过原价按原价", pricing.CouponRule{DiscountType: "AMOUNT", DiscountValue: 9000}, 5000, 5000},
		{"免单", pricing.CouponRule{DiscountType: "WAIVER"}, 5000, 5000},
		{"原价为 0", pricing.CouponRule{DiscountType: "PERCENT", DiscountValue: 50}, 0, 0},
		{"未知类型不减免", pricing.CouponRule{DiscountType: "BOGUS", DiscountValue: 50}, 5000, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, pricing.CouponDiscount(tc.rule, tc.list))
		})
	}
}

func TestAllocate(t *testing.T) {
	cases := []struct {
		name     string
		prices   []int64
		discount int64
		want     []int64
	}{
		{"无优惠", []int64{2500, 3000}, 0, []int64{2500, 3000}},
		{"余数大的先补", []int64{1800, 2000, 3000}, 682, []int64{1620, 1799, 2699}},
		{"余数相同按参赛人顺序", []int64{2500, 2500}, 1001, []int64{1999, 2000}},
		{"三人同价补两分", []int64{1000, 1000, 1000}, 2, []int64{999, 999, 1000}},
		{"全额减免", []int64{1200, 800}, 2000, []int64{0, 0}},
		{"原价为 0", []int64{0, 0}, 0, []int64{0, 0}},
		{"有人原价为 0", []int64{0, 3000}, 1, []int64{0, 2999}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pricing.Allocate(tc.prices, tc.discount)
			require.Equal(t, tc.want, got)
			var list, paid int64
			for i := range tc.prices {
				list += tc.prices[i]
				paid += got[i]
			}
			if list > 0 {
				require.Equal(t, list-tc.discount, paid, "分摊后总额必须等于应付")
			}
		})
	}
}

func TestPickIdentOffset(t *testing.T) {
	cases := []struct {
		name   string
		amount int64
		taken  map[int64]bool
		max    int64
		want   int64
	}{
		{"没有占用取 1", 5000, nil, 50, 1},
		{"跳过已占用金额", 5000, map[int64]bool{4999: true, 4998: true}, 50, 3},
		{"全部占用为 0", 5000, map[int64]bool{4999: true, 4998: true, 4997: true}, 3, 0},
		{"应付 1 分为 0", 1, nil, 50, 0},
		{"应付 2 分只能减 1", 2, map[int64]bool{1: true}, 50, 0},
		{"上限超过 50 按 50", 100, map[int64]bool{}, 80, 1},
		{"上限 0 为 0", 5000, nil, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, pricing.PickIdentOffset(tc.amount, tc.taken, tc.max))
		})
	}

	taken := map[int64]bool{}
	for i := int64(1); i <= 50; i++ {
		taken[10000-i] = true
	}
	require.Equal(t, int64(0), pricing.PickIdentOffset(10000, taken, 80), "上限封顶 50：1..50 全占用时不能取 51")
}
