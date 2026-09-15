// Package registration 负责报名下单、订单查询、取消与超时释放。
package registration

import (
	"time"

	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/runner"
)

// 订单状态、报名状态与限制。
const (
	StatusPendingPayment = "PENDING_PAYMENT"
	StatusProofSubmitted = "PROOF_SUBMITTED"
	StatusProofRejected  = "PROOF_REJECTED"
	StatusPaid           = "PAID"
	StatusExpired        = "EXPIRED"
	StatusCancelled      = "CANCELLED"

	RegistrationPending   = "PENDING"
	RegistrationConfirmed = "CONFIRMED"
	RegistrationCancelled = "CANCELLED"

	MinParticipants = 1
	MaxParticipants = 10

	idempotencyScope = "reg_order.create"
	idempotencyTTL   = 24 * time.Hour
)

// OrderParticipantInput 是下单时的一位参赛人：ProfileID 与 Profile 二选一。
type OrderParticipantInput struct {
	CategoryID    int64
	ProfileID     *int64
	Profile       *runner.ProfileData
	SaveAsProfile bool
}

// CreateOrderInput 是下单输入。
type CreateOrderInput struct {
	EventSlug      string
	CouponCode     string
	Consent        runner.ConsentAcceptance
	Participants   []OrderParticipantInput
	IdempotencyKey string
}

// QuotePreviewInput 是算价预览输入。
type QuotePreviewInput struct {
	CouponCode   string
	Participants []pricing.ParticipantInput
}

// Order 是订单主表字段。
type Order struct {
	ID, EventID, BuyerUserID int64
	OrderNo                  string
	Status                   string
	ReservationState         string
	ListAmountCents          int64
	DiscountCents            int64
	IdentOffsetCents         int64
	AmountCents              int64
	Currency                 string
	PaymentAccountID         int64
	DeadlineAt               *time.Time
	PaidAt                   *time.Time
	CreatedAt                time.Time
}

// OrderParticipant 是订单里的一位参赛人及其报名。
type OrderParticipant struct {
	RegistrationID     int64
	RegNo              string
	CategoryID         int64
	CategoryName       i18n.Text
	FullName           string
	PriceRuleID        int64
	ListPriceCents     int64
	PaidCents          int64
	RegistrationStatus string  // PENDING | CONFIRMED | CANCELLED
	TicketCode         *string // 仅 CONFIRMED 时非空
}

// PaymentAccountView 是订单页展示的收款账户。
type PaymentAccountView struct {
	ID              int64
	Name            string
	Provider        string
	AccountName     string
	AccountNoMasked string
	QRFileID        int64
}

// LastRejection 是最近一次凭证驳回。
type LastRejection struct {
	Code       string
	Reason     *string
	ReviewedAt time.Time
}

// OrderDetail 是订单详情。
type OrderDetail struct {
	Order
	EventSlug      string
	EventName      i18n.Text
	EventTimezone  string
	Participants   []OrderParticipant
	PaymentAccount PaymentAccountView
	LastRejection  *LastRejection
}

// OrderSummary 是订单列表的一行。
type OrderSummary struct {
	Order
	EventSlug        string
	EventName        i18n.Text
	ParticipantCount int
}
