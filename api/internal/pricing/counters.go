package pricing

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/pricing/store"
)

// 组别、价格档、优惠码三类计数只由本文件修改（免费活动报名除外）。
// 所有更新都按 组别 → 价格档 → 优惠码、同类按 id 升序执行，避免并发事务互相死锁。

type seatCount struct {
	id    int64
	seats int32
}

func groupSeats(q Quote, key func(ParticipantQuote) int64) []seatCount {
	counts := map[int64]int32{}
	for _, p := range q.Participants {
		counts[key(p)]++
	}
	out := make([]seatCount, 0, len(counts))
	for id, n := range counts {
		out = append(out, seatCount{id: id, seats: n})
	}
	slices.SortFunc(out, func(a, b seatCount) int { return cmp.Compare(a.id, b.id) })
	return out
}

// Reserve 按合并人数对组别、价格档做条件预留，有优惠码时预留一次使用；任何一条影响 0 行即返回对应 409 错误，
// 由调用方回滚整个事务。
func (s *Service) Reserve(ctx context.Context, tx pgx.Tx, q Quote) error {
	st := store.New(tx)
	for _, c := range groupSeats(q, func(p ParticipantQuote) int64 { return p.CategoryID }) {
		n, err := st.ReserveCategorySeats(ctx, store.ReserveCategorySeatsParams{Seats: c.seats, ID: c.id})
		if err != nil {
			return fmt.Errorf("reserve category %d: %w", c.id, err)
		}
		if n == 0 {
			return apperr.New(http.StatusConflict, apperr.CodeCategorySoldOut)
		}
	}
	for _, r := range groupSeats(q, func(p ParticipantQuote) int64 { return p.PriceRuleID }) {
		n, err := st.ReservePriceRuleSeats(ctx, store.ReservePriceRuleSeatsParams{Seats: r.seats, ID: r.id})
		if err != nil {
			return fmt.Errorf("reserve price rule %d: %w", r.id, err)
		}
		if n == 0 {
			return apperr.New(http.StatusConflict, apperr.CodePriceTierSoldOut)
		}
	}
	if q.CouponID != nil {
		n, err := st.ReserveCouponUse(ctx, *q.CouponID)
		if err != nil {
			return fmt.Errorf("reserve coupon %d: %w", *q.CouponID, err)
		}
		if n == 0 {
			return apperr.New(http.StatusConflict, apperr.CodeCouponExhausted)
		}
	}
	return nil
}

// RecordRedemption 在订单写入后记录优惠码核销（RESERVED）；没有优惠码时什么都不做。
func (s *Service) RecordRedemption(ctx context.Context, tx pgx.Tx, orderID int64, q Quote) error {
	if q.CouponID == nil {
		return nil
	}
	err := store.New(tx).InsertCouponRedemption(ctx, store.InsertCouponRedemptionParams{
		OrderID:       orderID,
		CouponID:      *q.CouponID,
		DiscountCents: q.CouponDiscountCents,
	})
	if err != nil {
		return fmt.Errorf("record coupon redemption for order %d: %w", orderID, err)
	}
	return nil
}

// Consume 把订单占用的名额从 reserved 转入 used，核销记录改为 CONSUMED。
// 调用方必须先用订单上的 reservation_state 条件更新保证每张订单只调用一次。
func (s *Service) Consume(ctx context.Context, tx pgx.Tx, orderID int64) error {
	return moveCounters(ctx, store.New(tx), orderID, true)
}

// Release 释放订单占用的名额，核销记录改为 RELEASED。调用约束同 Consume。
func (s *Service) Release(ctx context.Context, tx pgx.Tx, orderID int64) error {
	return moveCounters(ctx, store.New(tx), orderID, false)
}

// LockCountersForOrders 在一个事务要连续处理多张订单（如超时批量释放）时先调用：
// 按 组别 → 价格档 → 优惠码、同类 id 升序锁住这些订单涉及的全部计数行，
// 之后逐张 Release / Consume 只会更新本事务已持有的行，不会与单订单流程形成相反的加锁顺序。
func (s *Service) LockCountersForOrders(ctx context.Context, tx pgx.Tx, orderIDs []int64) error {
	if len(orderIDs) == 0 {
		return nil
	}
	q := store.New(tx)
	if err := q.LockCategoriesForOrders(ctx, orderIDs); err != nil {
		return fmt.Errorf("lock categories of %d orders: %w", len(orderIDs), err)
	}
	if err := q.LockPriceRulesForOrders(ctx, orderIDs); err != nil {
		return fmt.Errorf("lock price rules of %d orders: %w", len(orderIDs), err)
	}
	if err := q.LockCouponsForOrders(ctx, orderIDs); err != nil {
		return fmt.Errorf("lock coupons of %d orders: %w", len(orderIDs), err)
	}
	return nil
}

func moveCounters(ctx context.Context, q *store.Queries, orderID int64, consume bool) error {
	verb := "release"
	if consume {
		verb = "consume"
	}

	cats, err := q.ListOrderCategorySeats(ctx, orderID)
	if err != nil {
		return fmt.Errorf("%s: list category seats of order %d: %w", verb, orderID, err)
	}
	for _, c := range cats {
		var n int64
		if consume {
			n, err = q.ConsumeCategorySeats(ctx, store.ConsumeCategorySeatsParams{Seats: c.Seats, ID: c.CategoryID})
		} else {
			n, err = q.ReleaseCategorySeats(ctx, store.ReleaseCategorySeatsParams{Seats: c.Seats, ID: c.CategoryID})
		}
		if err != nil {
			return fmt.Errorf("%s category %d: %w", verb, c.CategoryID, err)
		}
		if n == 0 {
			return fmt.Errorf("%s category %d for order %d: fewer than %d reserved seats", verb, c.CategoryID, orderID, c.Seats)
		}
	}

	rules, err := q.ListOrderPriceRuleSeats(ctx, orderID)
	if err != nil {
		return fmt.Errorf("%s: list price rule seats of order %d: %w", verb, orderID, err)
	}
	for _, r := range rules {
		var n int64
		if consume {
			n, err = q.ConsumePriceRuleSeats(ctx, store.ConsumePriceRuleSeatsParams{Seats: r.Seats, ID: r.PriceRuleID})
		} else {
			n, err = q.ReleasePriceRuleSeats(ctx, store.ReleasePriceRuleSeatsParams{Seats: r.Seats, ID: r.PriceRuleID})
		}
		if err != nil {
			return fmt.Errorf("%s price rule %d: %w", verb, r.PriceRuleID, err)
		}
		if n == 0 {
			return fmt.Errorf("%s price rule %d for order %d: fewer than %d reserved seats", verb, r.PriceRuleID, orderID, r.Seats)
		}
	}

	state := "RELEASED"
	if consume {
		state = "CONSUMED"
	}
	couponID, err := q.MarkCouponRedemption(ctx, store.MarkCouponRedemptionParams{ToState: state, OrderID: orderID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%s coupon redemption of order %d: %w", verb, orderID, err)
	}
	var n int64
	if consume {
		n, err = q.ConsumeCouponUse(ctx, couponID)
	} else {
		n, err = q.ReleaseCouponUse(ctx, couponID)
	}
	if err != nil {
		return fmt.Errorf("%s coupon %d: %w", verb, couponID, err)
	}
	if n == 0 {
		return fmt.Errorf("%s coupon %d for order %d: no reserved use", verb, couponID, orderID)
	}
	return nil
}
