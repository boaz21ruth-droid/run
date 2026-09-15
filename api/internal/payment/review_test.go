package payment_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/payment"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/money"
	"werun/api/internal/runner"
)

type reviewCase struct {
	env     *paytest.Env
	fx      paytest.Fixture
	finance iam.Staff
}

func newReviewCase(t *testing.T) reviewCase {
	t.Helper()
	env := paytest.NewEnv(t)
	return reviewCase{env: env, fx: paytest.SeedEvent(t, env.Pool), finance: paytest.SeedStaff(t, env.Pool, iam.RoleFinance)}
}

// submitted 建订单并通过 SubmitProof 上传一份申报金额等于应付的凭证；截图颜色由 telegramID 决定。
func (c reviewCase) submitted(t *testing.T, telegramID int64, spec paytest.OrderSpec) (runner.User, paytest.OrderRef, payment.Proof) {
	t.Helper()
	u := paytest.SeedUser(t, c.env.Pool, telegramID, "Sokha Chan")
	order := paytest.SeedOrder(t, c.env, c.fx, u, spec)
	proof, err := c.env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, uint8(telegramID%251)), "TXN"+order.OrderNo, order.AmountCents), testMeta)
	require.NoError(t, err)
	return u, order, proof
}

func counters(t *testing.T, env *paytest.Env, table string, id int64) [2]int {
	t.Helper()
	var used, reserved int
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT used_count, reserved_count FROM `+table+` WHERE id = $1`, id).Scan(&used, &reserved))
	return [2]int{used, reserved}
}

func TestApproveExactAmountConfirmsOrderAndConsumesCounters(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7501, paytest.OrderSpec{WithCoupon: true})
	receivedAt := c.env.Clock.Now().Add(-10 * time.Minute)

	detail, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: receivedAt}, testMeta)

	require.NoError(t, err)
	require.Equal(t, proof.ID, detail.ID)
	require.Equal(t, "APPROVED", detail.Status)
	require.NotNil(t, detail.ReviewedBy)
	require.Equal(t, c.finance.ID, *detail.ReviewedBy)
	require.NotNil(t, detail.ReviewedAt)
	require.Equal(t, "PAID", detail.Order.Status)

	var status, reservation string
	var paidAt, deadline *time.Time
	require.NoError(t, c.env.Pool.QueryRow(ctx,
		`SELECT status, reservation_state, paid_at, deadline_at FROM reg_orders WHERE id = $1`, order.ID).
		Scan(&status, &reservation, &paidAt, &deadline))
	require.Equal(t, "PAID", status)
	require.Equal(t, "CONSUMED", reservation)
	require.NotNil(t, paidAt)
	require.True(t, paidAt.Equal(receivedAt), "paid_at 应等于到账时间")
	require.Nil(t, deadline)

	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `
		SELECT count(*) FROM registrations r JOIN order_participants op ON op.id = r.order_participant_id
		WHERE op.order_id = $1 AND r.status = 'CONFIRMED' AND r.confirmed_at IS NOT NULL`, order.ID))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "price_rules", c.fx.PriceRuleID))
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "coupons", c.fx.CouponID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM coupon_redemptions WHERE order_id = $1 AND state = 'CONSUMED'`, order.ID))

	var matchStatus, txnRef, recordedByType string
	var amount, recordedBy int64
	require.NoError(t, c.env.Pool.QueryRow(ctx,
		`SELECT match_status, amount_cents, txn_ref, recorded_by_type, recorded_by FROM payment_receipts WHERE proof_id = $1`, proof.ID).
		Scan(&matchStatus, &amount, &txnRef, &recordedByType, &recordedBy))
	require.Equal(t, "APPLIED", matchStatus)
	require.Equal(t, order.AmountCents, amount)
	require.Equal(t, proof.BankTxnRef, txnRef)
	require.Equal(t, "STAFF", recordedByType)
	require.Equal(t, c.finance.ID, recordedBy)
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_exceptions`))

	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'payment_proof.approve' AND entity_type = 'payment_proof' AND entity_id = $1
		  AND actor_type = 'STAFF' AND actor_id = $2 AND actor_role = 'FINANCE' AND is_financial`, proof.ID, c.finance.ID))
}

func TestApproveOverpaidRecordsOpenException(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7502, paytest.OrderSpec{})
	note := "客户多转了 1.50 美元"

	detail, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID, payment.ApproveInput{
		ReceivedAmountCents: order.AmountCents + 150, ReceivedAt: c.env.Clock.Now(), Note: &note,
	}, testMeta)

	require.NoError(t, err)
	require.Equal(t, "PAID", detail.Order.Status)
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "event_categories", c.fx.CategoryID))

	var receiptID, receiptAmount int64
	var matchStatus string
	require.NoError(t, c.env.Pool.QueryRow(ctx,
		`SELECT id, amount_cents, match_status FROM payment_receipts WHERE proof_id = $1`, proof.ID).
		Scan(&receiptID, &receiptAmount, &matchStatus))
	require.Equal(t, "EXCEPTION", matchStatus)
	require.Equal(t, order.AmountCents+150, receiptAmount)

	var exceptionNo, domain, typ, status string
	var exAmount, exReceipt int64
	var exNote *string
	require.NoError(t, c.env.Pool.QueryRow(ctx, `
		SELECT exception_no, domain, type, status, amount_cents, receipt_id, note
		FROM payment_exceptions WHERE reg_order_id = $1`, order.ID).
		Scan(&exceptionNo, &domain, &typ, &status, &exAmount, &exReceipt, &exNote))
	require.True(t, strings.HasPrefix(exceptionNo, "EX"))
	require.Len(t, exceptionNo, 10)
	require.Equal(t, "REGISTRATION", domain)
	require.Equal(t, "OVERPAID", typ)
	require.Equal(t, "OPEN", status)
	require.EqualValues(t, 150, exAmount)
	require.Equal(t, receiptID, exReceipt)
	require.Equal(t, &note, exNote)
}

func TestApproveUnderpaidChangesNothing(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7503, paytest.OrderSpec{})

	_, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents - 1, ReceivedAt: c.env.Clock.Now()}, testMeta)

	ae := requireAppErr(t, err, apperr.CodeReceivedAmountTooLow, http.StatusUnprocessableEntity)
	require.Equal(t, money.Cents(order.AmountCents).String(), ae.Params["amountDue"])
	require.Equal(t, apperr.CodeReceivedAmountTooLow, ae.Fields["receivedAmountCents"].Key)
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED' AND reviewed_by IS NULL`, proof.ID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED' AND reservation_state = 'RESERVED'`, order.ID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
	require.Equal(t, [2]int{0, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM audit_logs WHERE action = 'payment_proof.approve'`))
}

// 第二次通过同一份凭证必须 ORDER_STATE_CONFLICT，且不再核销名额：另一张订单在同一组别、价格档上的预留不受影响。
func TestReviewAfterApprovalConflicts(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7504, paytest.OrderSpec{})
	other := paytest.SeedUser(t, c.env.Pool, 7514, "Dara Chan")
	paytest.SeedOrder(t, c.env, c.fx, other, paytest.OrderSpec{IdentOffset: 2})
	require.Equal(t, [2]int{0, 2}, counters(t, c.env, "event_categories", c.fx.CategoryID))

	in := payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: c.env.Clock.Now()}
	_, err := c.env.Payments.ApproveProof(ctx, c.finance, proof.ID, in, testMeta)
	require.NoError(t, err)
	require.Equal(t, [2]int{1, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, [2]int{1, 1}, counters(t, c.env, "price_rules", c.fx.PriceRuleID))

	_, err = c.env.Payments.ApproveProof(ctx, c.finance, proof.ID, in, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	_, err = c.env.Payments.RejectProof(ctx, c.finance, proof.ID, payment.RejectInput{Code: "UNREADABLE"}, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)

	require.Equal(t, [2]int{1, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, [2]int{1, 1}, counters(t, c.env, "price_rules", c.fx.PriceRuleID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM audit_logs WHERE action = 'payment_proof.approve'`))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM audit_logs WHERE action = 'payment_proof.reject'`))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'APPROVED'`, proof.ID))
}

// 凭证仍为 SUBMITTED、但订单已不在审核中（例如数据被人工改动）时，通过与驳回都不做任何修改。
func TestReviewRequiresOrderUnderReview(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	u := paytest.SeedUser(t, c.env.Pool, 7515, "Sokha Chan")
	order := paytest.SeedOrder(t, c.env, c.fx, u, paytest.OrderSpec{Status: "PROOF_REJECTED"})
	proofID := paytest.SeedProof(t, c.env, c.fx, order, u, "SUBMITTED", "ABA-STATE-01", c.env.Clock.Now())

	_, err := c.env.Payments.ApproveProof(ctx, c.finance, proofID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: c.env.Clock.Now()}, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	_, err = c.env.Payments.RejectProof(ctx, c.finance, proofID, payment.RejectInput{Code: "UNREADABLE"}, testMeta)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)

	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proofID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_REJECTED'`, order.ID))
	require.Equal(t, [2]int{0, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
}

// payment_receipts 的 UNIQUE (payment_account_id, txn_ref) 未命名，PostgreSQL 生成的名字须与 review.go 注册的约束映射一致。
func TestReceiptTxnRefConstraintName(t *testing.T) {
	env := paytest.NewEnv(t)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `
		SELECT count(*) FROM pg_constraint
		WHERE conrelid = 'payment_receipts'::regclass AND contype = 'u'
		  AND conname = 'payment_receipts_payment_account_id_txn_ref_key'`))
	require.Equal(t, 1, paytest.Count(t, env.Pool, `
		SELECT count(*) FROM pg_constraint
		WHERE conrelid = 'payment_exceptions'::regclass AND contype = 'u'
		  AND conname = 'payment_exceptions_exception_no_key'`))
}

func TestApproveRejectsTxnRefAlreadyReceived(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7505, paytest.OrderSpec{})
	_, err := c.env.Pool.Exec(ctx, `
		INSERT INTO payment_receipts (payment_account_id, txn_ref, amount_cents, currency, received_at, match_status, recorded_by_type)
		VALUES ($1, $2, 999, 'USD', now(), 'UNMATCHED', 'SYSTEM')`, c.fx.AccountID, proof.BankTxnRef)
	require.NoError(t, err)

	_, err = c.env.Payments.ApproveProof(ctx, c.finance, proof.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents + 100, ReceivedAt: c.env.Clock.Now()}, testMeta)

	requireAppErr(t, err, apperr.CodeProofTxnRefUsed, http.StatusConflict)
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED' AND reviewed_by IS NULL`, proof.ID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED' AND reservation_state = 'RESERVED'`, order.ID))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_exceptions`))
	require.Equal(t, [2]int{0, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM audit_logs WHERE action = 'payment_proof.approve'`))
}

func TestApproveValidatesInput(t *testing.T) {
	c := newReviewCase(t)
	_, order, proof := c.submitted(t, 7506, paytest.OrderSpec{})
	longNote := strings.Repeat("备", 501)
	now := c.env.Clock.Now()

	cases := []struct {
		name  string
		in    payment.ApproveInput
		field string
		key   string
	}{
		{"到账金额为 0", payment.ApproveInput{ReceivedAmountCents: 0, ReceivedAt: now}, "receivedAmountCents", "field.must_be_positive"},
		{"缺少到账时间", payment.ApproveInput{ReceivedAmountCents: order.AmountCents}, "receivedAt", "field.required"},
		{"到账时间在未来", payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: now.Add(time.Hour)}, "receivedAt", "field.invalid"},
		{"备注超过 500 字", payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: now, Note: &longNote}, "note", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.env.Payments.ApproveProof(context.Background(), c.finance, proof.ID, tc.in, testMeta)
			ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key)
		})
	}

	_, err := c.env.Payments.ApproveProof(context.Background(), c.finance, 999999,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: now}, testMeta)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proof.ID))
}

func TestRejectOpensReuploadWindow(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7507, paytest.OrderSpec{})
	reason := "  看不清金额  "

	detail, err := c.env.Payments.RejectProof(ctx, c.finance, proof.ID, payment.RejectInput{Code: "unreadable", Reason: &reason}, testMeta)

	require.NoError(t, err)
	require.Equal(t, "REJECTED", detail.Status)
	require.NotNil(t, detail.RejectCode)
	require.Equal(t, "UNREADABLE", *detail.RejectCode)
	require.NotNil(t, detail.RejectReason)
	require.Equal(t, "看不清金额", *detail.RejectReason)
	require.Equal(t, "PROOF_REJECTED", detail.Order.Status)
	wantDeadline := c.env.Clock.Now().Add(24 * time.Hour)
	require.NotNil(t, detail.Order.DeadlineAt)
	require.True(t, detail.Order.DeadlineAt.Equal(wantDeadline), "重传截止应为 now+24h，得到 %v", detail.Order.DeadlineAt)

	var deadline *time.Time
	require.NoError(t, c.env.Pool.QueryRow(ctx, `SELECT deadline_at FROM reg_orders WHERE id = $1`, order.ID).Scan(&deadline))
	require.NotNil(t, deadline)
	require.True(t, deadline.Equal(wantDeadline))
	require.Equal(t, [2]int{0, 1}, counters(t, c.env, "event_categories", c.fx.CategoryID))
	require.Equal(t, 0, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_receipts`))
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'payment_proof.reject' AND entity_id = $1 AND actor_id = $2 AND is_financial`, proof.ID, c.finance.ID))
}

func TestRejectValidatesCodeAndReason(t *testing.T) {
	c := newReviewCase(t)
	_, _, proof := c.submitted(t, 7508, paytest.OrderSpec{})
	blank := "   "
	long := strings.Repeat("理", 501)

	cases := []struct {
		name  string
		in    payment.RejectInput
		field string
		key   string
	}{
		{"未知原因码", payment.RejectInput{Code: "LOST"}, "rejectCode", "field.invalid"},
		{"OTHER 不填说明", payment.RejectInput{Code: "OTHER"}, "rejectReason", "field.required"},
		{"OTHER 说明全是空白", payment.RejectInput{Code: "OTHER", Reason: &blank}, "rejectReason", "field.required"},
		{"OTHER 说明超过 500 字", payment.RejectInput{Code: "OTHER", Reason: &long}, "rejectReason", "field.too_long"},
		{"说明超过 500 字", payment.RejectInput{Code: "UNREADABLE", Reason: &long}, "rejectReason", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.env.Payments.RejectProof(context.Background(), c.finance, proof.ID, tc.in, testMeta)
			ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key)
		})
	}
	require.Equal(t, 1, paytest.Count(t, c.env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proof.ID))
}

func TestReuploadAfterRejectionThenApprove(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	u, order, first := c.submitted(t, 7509, paytest.OrderSpec{})
	_, err := c.env.Payments.RejectProof(ctx, c.finance, first.ID, payment.RejectInput{Code: "AMOUNT_MISMATCH"}, testMeta)
	require.NoError(t, err)

	c.env.Clock.Advance(time.Hour)
	second, err := c.env.Payments.SubmitProof(ctx, u, order.OrderNo,
		proofInput(paytest.PNG(t, 222), first.BankTxnRef, order.AmountCents), testMeta)
	require.NoError(t, err)
	detail, err := c.env.Payments.ApproveProof(ctx, c.finance, second.ID,
		payment.ApproveInput{ReceivedAmountCents: order.AmountCents, ReceivedAt: c.env.Clock.Now()}, testMeta)

	require.NoError(t, err)
	require.Equal(t, "PAID", detail.Order.Status)
	require.Len(t, detail.Order.Proofs, 2)
	require.Equal(t, second.ID, detail.Order.Proofs[0].ID)
	require.Equal(t, "APPROVED", detail.Order.Proofs[0].Status)
	require.Equal(t, first.ID, detail.Order.Proofs[1].ID)
	require.Equal(t, "REJECTED", detail.Order.Proofs[1].Status)
	require.Len(t, detail.Order.Receipts, 1)
	require.Equal(t, [2]int{1, 0}, counters(t, c.env, "event_categories", c.fx.CategoryID))
}

func TestListProofsQueueOrderAndSLA(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, p1 := c.submitted(t, 7510, paytest.OrderSpec{})
	_, _, p2 := c.submitted(t, 7511, paytest.OrderSpec{})
	_, _, p3 := c.submitted(t, 7512, paytest.OrderSpec{})
	now := c.env.Clock.Now()
	for id, at := range map[int64]time.Time{p1.ID: now.Add(-25 * time.Hour), p2.ID: now.Add(-2 * time.Hour), p3.ID: now.Add(-time.Hour)} {
		_, err := c.env.Pool.Exec(ctx, `UPDATE payment_proofs SET created_at = $2 WHERE id = $1`, id, at)
		require.NoError(t, err)
	}
	_, err := c.env.Payments.RejectProof(ctx, c.finance, p3.ID, payment.RejectInput{Code: "NOT_RECEIVED"}, testMeta)
	require.NoError(t, err)

	items, err := c.env.Payments.ListProofs(ctx, "")
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, p1.ID, items[0].ID)
	require.Equal(t, p2.ID, items[1].ID)
	require.True(t, items[0].OverSLA)
	require.False(t, items[1].OverSLA)
	require.Equal(t, order.AmountCents, items[0].AmountCents)
	require.Equal(t, order.OrderNo, items[0].OrderNo)
	require.Equal(t, "Phnom Penh Half Marathon 2026", items[0].EventName[i18n.EN])
	require.True(t, items[0].WaitingSince.Equal(now.Add(-25*time.Hour)))

	rejected, err := c.env.Payments.ListProofs(ctx, "rejected")
	require.NoError(t, err)
	require.Len(t, rejected, 1)
	require.Equal(t, p3.ID, rejected[0].ID)
	require.False(t, rejected[0].OverSLA)

	_, err = c.env.Payments.ListProofs(ctx, "WITHDRAWN")
	ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
	require.Equal(t, "field.invalid", ae.Fields["status"].Key)
}

func TestGetProofAndOpenProofFile(t *testing.T) {
	c := newReviewCase(t)
	ctx := context.Background()
	_, order, proof := c.submitted(t, 7513, paytest.OrderSpec{})

	detail, err := c.env.Payments.GetProof(ctx, proof.ID)
	require.NoError(t, err)
	require.Equal(t, order.OrderNo, detail.OrderNo)
	require.Equal(t, order.ID, detail.Order.ID)
	require.Len(t, detail.Order.Proofs, 1)

	_, err = c.env.Payments.GetProof(ctx, 999999)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)

	file, body, err := c.env.Payments.OpenProofFile(ctx, proof.FileID)
	require.NoError(t, err)
	data, err := io.ReadAll(body)
	require.NoError(t, body.Close())
	require.NoError(t, err)
	require.Equal(t, "image/png", file.MIME)
	require.Equal(t, paytest.PNG(t, uint8(7513%251)), data)

	// 收款二维码（公开）、未被凭证引用的私有文件、被改成公开的凭证文件，都不能通过本方法读取。
	_, _, err = c.env.Payments.OpenProofFile(ctx, c.fx.QRFileID)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)
	var otherPrivate int64
	require.NoError(t, c.env.Pool.QueryRow(ctx, `
		INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		VALUES ('review-test/refund.png', 'PRIVATE', 'REFUND_PROOF', 'image/png', 128, '\x00', 'SYSTEM')
		RETURNING id`).Scan(&otherPrivate))
	_, _, err = c.env.Payments.OpenProofFile(ctx, otherPrivate)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)
	_, err = c.env.Pool.Exec(ctx, `UPDATE files SET visibility = 'PUBLIC' WHERE id = $1`, proof.FileID)
	require.NoError(t, err)
	_, _, err = c.env.Payments.OpenProofFile(ctx, proof.FileID)
	requireAppErr(t, err, apperr.CodeNotFound, http.StatusNotFound)
}
