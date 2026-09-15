package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/registration/store"
)

const (
	adminOrdersDefaultLimit int32 = 20
	adminOrdersMaxLimit     int32 = 100
)

var adminOrderStatuses = map[string]bool{
	"PENDING_PAYMENT": true, "PROOF_SUBMITTED": true, "PROOF_REJECTED": true, "PAID": true,
	"PARTIALLY_REFUNDED": true, "REFUNDED": true, "EXPIRED": true, "CANCELLED": true,
}

// AdminOrderFilter 是后台订单列表的筛选条件。Status 为空表示不限；Query 匹配订单号、手机号或买家姓名。
type AdminOrderFilter struct {
	EventID       *int64
	Status        string
	Query         string
	Limit, Offset int32
}

// AdminOrderDetail 是后台订单详情：跑者可见的订单详情加买家、凭证历史、到账记录与优惠码。
type AdminOrderDetail struct {
	OrderDetail
	BuyerName, BuyerPhone string
	Proofs                []ProofHistoryItem
	Receipts              []ReceiptItem
	Coupon                *AppliedCoupon
}

type ProofHistoryItem struct {
	ID                          int64
	ProofNo, Status, BankTxnRef string
	DeclaredAmountCents         int64
	RejectCode                  *string
	CreatedAt                   time.Time
	ReviewedAt                  *time.Time
}

type ReceiptItem struct {
	ID          int64
	TxnRef      string
	AmountCents int64
	ReceivedAt  time.Time
	MatchStatus string
}

type AppliedCoupon struct {
	Code          string
	DiscountCents int64
	State         string
}

// AdminListOrders 按条件分页列出订单（创建时间倒序），并返回满足条件的总数。
func (s *Service) AdminListOrders(ctx context.Context, f AdminOrderFilter) ([]OrderSummary, int64, error) {
	status := strings.ToUpper(strings.TrimSpace(f.Status))
	if status != "" && !adminOrderStatuses[status] {
		return nil, 0, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).WithField("status", "field.invalid", nil)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = adminOrdersDefaultLimit
	}
	limit = min(limit, adminOrdersMaxLimit)
	offset := max(f.Offset, 0)
	query := strings.TrimSpace(f.Query)
	like := escapeLike(query)

	q := store.New(s.pool)
	rows, err := q.AdminListRegOrders(ctx, store.AdminListRegOrdersParams{
		EventID: f.EventID, Status: status, Q: query, QLike: like, RowLimit: limit, RowOffset: offset,
	})
	if err != nil {
		return nil, 0, fmt.Errorf("admin list orders: %w", err)
	}
	total, err := q.AdminCountRegOrders(ctx, store.AdminCountRegOrdersParams{
		EventID: f.EventID, Status: status, Q: query, QLike: like,
	})
	if err != nil {
		return nil, 0, fmt.Errorf("admin count orders: %w", err)
	}

	items := make([]OrderSummary, 0, len(rows))
	for _, r := range rows {
		name, err := decodeText(r.EventName, "event name")
		if err != nil {
			return nil, 0, err
		}
		items = append(items, OrderSummary{
			Order:            orderFromLockedRow(r.RegOrder),
			EventSlug:        r.EventSlug,
			EventName:        name,
			ParticipantCount: int(r.ParticipantCount),
		})
	}
	return items, total, nil
}

// AdminGetOrder 返回后台订单详情；不存在返回 ORDER_NOT_FOUND。
func (s *Service) AdminGetOrder(ctx context.Context, id int64) (AdminOrderDetail, error) {
	q := store.New(s.pool)
	buyer, err := q.AdminGetRegOrderBuyer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminOrderDetail{}, apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
	}
	if err != nil {
		return AdminOrderDetail{}, fmt.Errorf("get order %d: %w", id, err)
	}
	detail, err := s.loadDetail(ctx, q, id)
	if err != nil {
		return AdminOrderDetail{}, err
	}
	out := AdminOrderDetail{OrderDetail: detail, BuyerName: buyer.BuyerName, BuyerPhone: buyer.BuyerPhoneE164}

	proofs, err := q.AdminListOrderProofs(ctx, id)
	if err != nil {
		return AdminOrderDetail{}, fmt.Errorf("list proofs of order %d: %w", id, err)
	}
	out.Proofs = make([]ProofHistoryItem, 0, len(proofs))
	for _, p := range proofs {
		out.Proofs = append(out.Proofs, ProofHistoryItem{
			ID: p.ID, ProofNo: p.ProofNo, Status: p.Status, BankTxnRef: p.BankTxnRef,
			DeclaredAmountCents: p.DeclaredAmountCents, RejectCode: p.RejectCode,
			CreatedAt: p.CreatedAt, ReviewedAt: p.ReviewedAt,
		})
	}

	receipts, err := q.AdminListOrderReceipts(ctx, id)
	if err != nil {
		return AdminOrderDetail{}, fmt.Errorf("list receipts of order %d: %w", id, err)
	}
	out.Receipts = make([]ReceiptItem, 0, len(receipts))
	for _, r := range receipts {
		out.Receipts = append(out.Receipts, ReceiptItem{
			ID: r.ID, TxnRef: r.TxnRef, AmountCents: r.AmountCents, ReceivedAt: r.ReceivedAt, MatchStatus: r.MatchStatus,
		})
	}

	coupon, err := q.AdminGetOrderCoupon(ctx, id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return AdminOrderDetail{}, fmt.Errorf("get coupon of order %d: %w", id, err)
	default:
		out.Coupon = &AppliedCoupon{Code: coupon.Code, DiscountCents: coupon.DiscountCents, State: coupon.State}
	}
	return out, nil
}

// escapeLike 转义 LIKE 通配符，配合 SQL 中的 ESCAPE '\'。
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
