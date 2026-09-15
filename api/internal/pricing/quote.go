package pricing

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/settings"
	"werun/api/internal/pricing/store"
)

const (
	localNationality          = "KH"
	identOffsetCapCents int64 = 50
	quoteCurrency             = "USD"
)

// ParticipantInput 是算价需要的参赛人信息。
type ParticipantInput struct {
	CategoryID  int64
	Nationality string
	BirthDate   time.Time
}

// QuoteInput 是算价输入。PaymentAccountID 为 nil 时是预览：不选识别分、不加锁。
type QuoteInput struct {
	EventID          int64
	RaceDate         time.Time
	CouponCode       string // 空串表示不用
	Participants     []ParticipantInput
	Now              time.Time
	PaymentAccountID *int64
}

// ParticipantQuote 是单个参赛人的价格快照。
type ParticipantQuote struct {
	CategoryID, PriceRuleID int64
	Audience                string // ALL | LOCAL
	ListPriceCents          int64
	PaidCents               int64
}

// Quote 是整单算价结果。
type Quote struct {
	Participants        []ParticipantQuote
	ListAmountCents     int64
	CouponID            *int64
	CouponDiscountCents int64
	IdentOffsetCents    int64
	DiscountCents       int64
	AmountCents         int64
	Currency            string // "USD"
}

// TierCandidate 是某个组别可用的一档价格。
type TierCandidate struct {
	PriceRuleID   int64
	Audience      string
	PriceCents    int64
	Quota         *int32
	UsedCount     int32
	ReservedCount int32
	SaleStartsAt  *time.Time
	SaleEndsAt    *time.Time
	SortOrder     int16
}

// CouponRule 是优惠码的减免规则。
type CouponRule struct {
	DiscountType  string // PERCENT | AMOUNT | WAIVER
	DiscountValue int64
}

// SelectTier 按 spec 5 第 1 步选价格档：人群、销售时间、配额（含本单已选人数）都满足的候选中，
// 取价格最低的；同价取 sort_order 小的，再同取 id 小的。
func SelectTier(cands []TierCandidate, nationality string, now time.Time, takenInOrder map[int64]int) (TierCandidate, bool) {
	var best TierCandidate
	found := false
	for _, c := range cands {
		switch c.Audience {
		case AudienceAll:
		case AudienceLocal:
			if nationality != localNationality {
				continue
			}
		default:
			continue
		}
		if c.SaleStartsAt != nil && c.SaleStartsAt.After(now) {
			continue
		}
		if c.SaleEndsAt != nil && !c.SaleEndsAt.After(now) {
			continue
		}
		if c.Quota != nil &&
			int64(c.UsedCount)+int64(c.ReservedCount)+int64(takenInOrder[c.PriceRuleID]) >= int64(*c.Quota) {
			continue
		}
		if !found || tierLess(c, best) {
			best = c
			found = true
		}
	}
	return best, found
}

func tierLess(a, b TierCandidate) bool {
	if a.PriceCents != b.PriceCents {
		return a.PriceCents < b.PriceCents
	}
	if a.SortOrder != b.SortOrder {
		return a.SortOrder < b.SortOrder
	}
	return a.PriceRuleID < b.PriceRuleID
}

// AgeOn 返回 raceDate 当天的周岁。2 月 29 日出生者在非闰年按 3 月 1 日满岁。
// 两个参数都是日期（UTC 零点），只看年月日。
func AgeOn(birth, raceDate time.Time) int {
	by, bm, bd := birth.Date()
	ry, rm, rd := raceDate.Date()
	if bm == time.February && bd == 29 && !isLeapYear(ry) {
		bm, bd = time.March, 1
	}
	age := ry - by
	if rm < bm || (rm == bm && rd < bd) {
		age--
	}
	return age
}

func isLeapYear(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

// CouponDiscount 计算优惠码减免：PERCENT 向下取整，AMOUNT 不超过原价，WAIVER 全免。
func CouponDiscount(c CouponRule, listAmount int64) int64 {
	if listAmount <= 0 {
		return 0
	}
	switch c.DiscountType {
	case DiscountPercent:
		return listAmount * min(max(c.DiscountValue, 0), 100) / 100
	case DiscountAmount:
		return min(max(c.DiscountValue, 0), listAmount)
	case DiscountWaiver:
		return listAmount
	}
	return 0
}

// Allocate 把整单减免按原价比例分摊到每人，返回每人 paid_cents。
// 先按 floor(discount × price / list) 分摊，剩余的分按被舍去的余数从大到小逐分补齐，余数相同按参赛人顺序；
// 结果之和恒等于 list − discount。原价合计为 0 时每人 0。
func Allocate(listPrices []int64, discount int64) []int64 {
	paid := make([]int64, len(listPrices))
	var total int64
	for _, p := range listPrices {
		total += p
	}
	if total <= 0 {
		return paid
	}
	discount = min(max(discount, 0), total)

	type remainder struct {
		idx int
		rem int64
	}
	rems := make([]remainder, 0, len(listPrices))
	var allocated int64
	for i, p := range listPrices {
		share := discount * p / total
		paid[i] = p - share
		allocated += share
		rems = append(rems, remainder{idx: i, rem: discount * p % total})
	}
	slices.SortStableFunc(rems, func(a, b remainder) int {
		switch {
		case a.rem > b.rem:
			return -1
		case a.rem < b.rem:
			return 1
		}
		return 0
	})
	for k := int64(0); k < discount-allocated; k++ {
		paid[rems[k].idx]--
	}
	return paid
}

// PickIdentOffset 在 1..min(maxCents, 50, amount−1) 中找最小的 n，使 amount−n 不在 taken 中；找不到返回 0。
func PickIdentOffset(amountAfterCoupon int64, taken map[int64]bool, maxCents int64) int64 {
	limit := min(maxCents, identOffsetCapCents, amountAfterCoupon-1)
	for n := int64(1); n <= limit; n++ {
		if !taken[amountAfterCoupon-n] {
			return n
		}
	}
	return 0
}

// Quote 在调用方事务里按 spec 5 算价。PaymentAccountID 非空且扣除优惠码后仍需付款时，
// 先对收款账户加事务级 advisory 锁，再从该账户未完成订单的应付金额中避开，选出识别分。
func (s *Service) Quote(ctx context.Context, tx pgx.Tx, in QuoteInput) (Quote, error) {
	q := store.New(tx)

	categoryIDs := make([]int64, 0, len(in.Participants))
	for _, p := range in.Participants {
		if !slices.Contains(categoryIDs, p.CategoryID) {
			categoryIDs = append(categoryIDs, p.CategoryID)
		}
	}
	catRows, err := q.QuoteListCategories(ctx, store.QuoteListCategoriesParams{EventID: in.EventID, CategoryIds: categoryIDs})
	if err != nil {
		return Quote{}, fmt.Errorf("quote: list categories: %w", err)
	}
	minAges := make(map[int64]int, len(catRows))
	for _, c := range catRows {
		minAges[c.ID] = int(c.MinAge)
	}
	tierRows, err := q.QuoteListTierCandidates(ctx, store.QuoteListTierCandidatesParams{EventID: in.EventID, CategoryIds: categoryIDs})
	if err != nil {
		return Quote{}, fmt.Errorf("quote: list price tiers: %w", err)
	}
	cands := make(map[int64][]TierCandidate, len(categoryIDs))
	for _, r := range tierRows {
		cands[r.CategoryID] = append(cands[r.CategoryID], TierCandidate{
			PriceRuleID:   r.PriceRuleID,
			Audience:      r.Audience,
			PriceCents:    r.PriceCents,
			Quota:         r.Quota,
			UsedCount:     r.UsedCount,
			ReservedCount: r.ReservedCount,
			SaleStartsAt:  r.SaleStartsAt,
			SaleEndsAt:    r.SaleEndsAt,
			SortOrder:     r.SortOrder,
		})
	}

	out := Quote{Currency: quoteCurrency, Participants: make([]ParticipantQuote, 0, len(in.Participants))}
	verr := validationError()
	failed := false
	taken := map[int64]int{}
	for i, p := range in.Participants {
		prefix := fmt.Sprintf("participants[%d].", i)
		minAge, ok := minAges[p.CategoryID]
		if !ok {
			verr = verr.WithField(prefix+"categoryId", "field.category_unavailable", nil)
			failed = true
			continue
		}
		if AgeOn(p.BirthDate, in.RaceDate) < minAge {
			verr = verr.WithField(prefix+"birthDate", "field.too_young", map[string]any{"minAge": minAge})
			failed = true
		}
		tier, ok := SelectTier(cands[p.CategoryID], strings.ToUpper(strings.TrimSpace(p.Nationality)), in.Now, taken)
		if !ok {
			verr = verr.WithField(prefix+"categoryId", "field.category_unavailable", nil)
			failed = true
			continue
		}
		taken[tier.PriceRuleID]++
		out.Participants = append(out.Participants, ParticipantQuote{
			CategoryID:     p.CategoryID,
			PriceRuleID:    tier.PriceRuleID,
			Audience:       tier.Audience,
			ListPriceCents: tier.PriceCents,
		})
		out.ListAmountCents += tier.PriceCents
	}
	if failed {
		return Quote{}, verr
	}

	if code := strings.ToUpper(strings.TrimSpace(in.CouponCode)); code != "" {
		id, rule, err := checkCoupon(ctx, q, code, in)
		if err != nil {
			return Quote{}, err
		}
		out.CouponID = &id
		out.CouponDiscountCents = CouponDiscount(rule, out.ListAmountCents)
	}

	afterCoupon := out.ListAmountCents - out.CouponDiscountCents
	if in.PaymentAccountID != nil && afterCoupon > 0 {
		offset, err := pickIdentOffsetLocked(ctx, tx, q, *in.PaymentAccountID, afterCoupon)
		if err != nil {
			return Quote{}, err
		}
		out.IdentOffsetCents = offset
	}
	out.DiscountCents = out.CouponDiscountCents + out.IdentOffsetCents
	out.AmountCents = out.ListAmountCents - out.DiscountCents

	prices := make([]int64, len(out.Participants))
	for i, p := range out.Participants {
		prices[i] = p.ListPriceCents
	}
	for i, paid := range Allocate(prices, out.DiscountCents) {
		out.Participants[i].PaidCents = paid
	}
	return out, nil
}

// checkCoupon 校验优惠码（code 已转大写）。不可用返回 COUPON_INVALID（字段 couponCode），次数用完返回 COUPON_EXHAUSTED。
func checkCoupon(ctx context.Context, q *store.Queries, code string, in QuoteInput) (int64, CouponRule, error) {
	invalid := apperr.New(http.StatusUnprocessableEntity, apperr.CodeCouponInvalid).
		WithField("couponCode", "field.coupon_invalid", nil)
	c, err := q.QuoteGetCouponByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, CouponRule{}, invalid
	}
	if err != nil {
		return 0, CouponRule{}, fmt.Errorf("quote: load coupon: %w", err)
	}
	if c.Status != CouponActive ||
		(c.EventID != nil && *c.EventID != in.EventID) ||
		(c.ValidFrom != nil && c.ValidFrom.After(in.Now)) ||
		(c.ValidUntil != nil && !c.ValidUntil.After(in.Now)) ||
		(c.MinRunners != nil && int(*c.MinRunners) > len(in.Participants)) {
		return 0, CouponRule{}, invalid
	}
	if int64(c.UsedCount)+int64(c.ReservedCount) >= int64(c.Quota) {
		return 0, CouponRule{}, apperr.New(http.StatusConflict, apperr.CodeCouponExhausted)
	}
	return c.ID, CouponRule{DiscountType: c.DiscountType, DiscountValue: c.DiscountValue}, nil
}

// pickIdentOffsetLocked 对收款账户加 pg_advisory_xact_lock(7301, accountID)（事务结束自动释放），
// 再读该账户未完成订单的应付金额与识别分上限，选出识别分。
func pickIdentOffsetLocked(ctx context.Context, tx pgx.Tx, q *store.Queries, accountID, afterCoupon int64) (int64, error) {
	if err := q.QuoteLockPaymentAccount(ctx, int32(accountID)); err != nil {
		return 0, fmt.Errorf("quote: lock payment account %d: %w", accountID, err)
	}
	amounts, err := q.QuoteListOpenOrderAmounts(ctx, accountID)
	if err != nil {
		return 0, fmt.Errorf("quote: list open order amounts: %w", err)
	}
	pay, err := settings.LoadPayment(ctx, tx)
	if err != nil {
		return 0, fmt.Errorf("quote: load payment settings: %w", err)
	}
	taken := make(map[int64]bool, len(amounts))
	for _, a := range amounts {
		taken[a] = true
	}
	return PickIdentOffset(afterCoupon, taken, pay.IdentOffsetMaxCents), nil
}
