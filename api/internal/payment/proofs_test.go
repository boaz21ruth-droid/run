package payment_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/payment"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
)

var testMeta = httpx.Meta{RequestID: "req-proof-test", IP: "203.0.113.7", UserAgent: "proofs-test"}

func proofInput(file []byte, txnRef string, amount int64) payment.SubmitProofInput {
	return payment.SubmitProofInput{File: bytes.NewReader(file), BankTxnRef: txnRef, DeclaredAmountCents: amount}
}

// requireAppErr 断言错误码与状态码，返回错误值（非指针，避免 errcheck 把它当成未检查的 error）。
func requireAppErr(t *testing.T, err error, code string, status int) apperr.Error {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, code, ae.Code)
	require.Equal(t, status, ae.Status)
	return *ae
}

func orderState(t *testing.T, env *paytest.Env, orderID int64) (string, *time.Time) {
	t.Helper()
	var status string
	var deadline *time.Time
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT status, deadline_at FROM reg_orders WHERE id = $1`, orderID).Scan(&status, &deadline))
	return status, deadline
}

func TestSubmitProofMovesOrderToReview(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7001, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})
	img := paytest.PNG(t, 10)
	paidAt := env.Clock.Now().Add(-5 * time.Minute)
	payer := "SOKHA CHAN"
	in := proofInput(img, "  aba 7788\t99 ", order.AmountCents)
	in.DeclaredPaidAt = &paidAt
	in.PayerName = &payer

	proof, err := env.Payments.SubmitProof(ctx, u, strings.ToLower(order.OrderNo), in, testMeta)

	require.NoError(t, err)
	require.True(t, strings.HasPrefix(proof.ProofNo, "PF"))
	require.Len(t, proof.ProofNo, 10)
	require.Equal(t, "ABA778899", proof.BankTxnRef)
	require.Equal(t, "SUBMITTED", proof.Status)
	require.Equal(t, order.ID, proof.OrderID)
	require.Equal(t, order.OrderNo, proof.OrderNo)
	require.Equal(t, fx.AccountID, proof.PaymentAccountID)
	require.Equal(t, order.AmountCents, proof.DeclaredAmountCents)
	require.False(t, proof.DupFileHit)
	require.NotNil(t, proof.DeclaredPaidAt)
	require.True(t, proof.DeclaredPaidAt.Equal(paidAt))
	require.Equal(t, &payer, proof.PayerName)
	require.Nil(t, proof.ReviewedAt)

	status, deadline := orderState(t, env, order.ID)
	require.Equal(t, "PROOF_SUBMITTED", status)
	require.Nil(t, deadline)

	var key, visibility, purpose, uploadedByType string
	var uploadedByID int64
	require.NoError(t, env.Pool.QueryRow(ctx, `
		SELECT storage_key, visibility, purpose, uploaded_by_type, uploaded_by_id FROM files WHERE id = $1`, proof.FileID).
		Scan(&key, &visibility, &purpose, &uploadedByType, &uploadedByID))
	require.Equal(t, "PRIVATE", visibility)
	require.Equal(t, "PAYMENT_PROOF", purpose)
	require.Equal(t, "USER", uploadedByType)
	require.Equal(t, u.ID, uploadedByID)
	require.Equal(t, []string{key}, env.Store.Puts())
	require.Empty(t, env.Store.Deletes())

	rc, err := env.Store.Open(ctx, key)
	require.NoError(t, err)
	stored, err := io.ReadAll(rc)
	require.NoError(t, rc.Close())
	require.NoError(t, err)
	require.Equal(t, img, stored)

	require.Equal(t, 1, paytest.Count(t, env.Pool, `
		SELECT count(*) FROM audit_logs
		WHERE action = 'payment_proof.submit' AND entity_type = 'payment_proof' AND entity_id = $1
		  AND actor_type = 'USER' AND actor_id = $2 AND is_financial AND request_id = 'req-proof-test'`, proof.ID, u.ID))
}

func TestSubmitProofAfterRejectionAllowsSameTxnRef(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7002, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_REJECTED"})
	paytest.SeedProof(t, env, fx, order, u, "REJECTED", "ABA778899", env.Clock.Now().Add(-2*time.Hour))

	proof, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, 11), "ABA 778899", order.AmountCents), testMeta)

	require.NoError(t, err)
	require.Equal(t, "ABA778899", proof.BankTxnRef)
	status, deadline := orderState(t, env, order.ID)
	require.Equal(t, "PROOF_SUBMITTED", status)
	require.Nil(t, deadline)
	require.Equal(t, 2, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE reg_order_id = $1`, order.ID))
}

func TestSubmitProofExpiredOrder(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7003, "Sokha Chan")
	past := env.Clock.Now().Add(-time.Minute)
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{DeadlineAt: &past})

	_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, 12), "ABA778899", order.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeOrderExpired, http.StatusConflict)
	status, _ := orderState(t, env, order.ID)
	require.Equal(t, "PENDING_PAYMENT", status)
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
	require.Len(t, env.Store.Puts(), 1)
	require.Equal(t, env.Store.Puts(), env.Store.Deletes())
}

func TestSubmitProofOnOthersOrderIsNotFound(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	owner := paytest.SeedUser(t, env.Pool, 7004, "Sokha Chan")
	stranger := paytest.SeedUser(t, env.Pool, 7005, "Dara Meas")
	order := paytest.SeedOrder(t, env, fx, owner, paytest.OrderSpec{})

	_, err := env.Payments.SubmitProof(ctx, stranger, order.OrderNo,
		proofInput(paytest.PNG(t, 13), "ABA778899", order.AmountCents), testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	_, err = env.Payments.SubmitProof(ctx, owner, "WR00000000",
		proofInput(paytest.PNG(t, 13), "ABA778899", order.AmountCents), testMeta)
	requireAppErr(t, err, apperr.CodeOrderNotFound, http.StatusNotFound)

	status, _ := orderState(t, env, order.ID)
	require.Equal(t, "PENDING_PAYMENT", status)
	require.Equal(t, env.Store.Puts(), env.Store.Deletes())
}

func TestSubmitProofRequiresPayableOrderState(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7006, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED"})

	_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput(paytest.PNG(t, 14), "ABA778899", order.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
}

func TestSubmitProofValidatesFields(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7007, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})
	longName := strings.Repeat("N", 101)

	cases := []struct {
		name  string
		in    payment.SubmitProofInput
		field string
		key   string
	}{
		{"交易号为空", proofInput(paytest.PNG(t, 20), "   ", order.AmountCents), "bankTxnRef", "field.required"},
		{"交易号去空白后不足 4 位", proofInput(paytest.PNG(t, 21), "ab 1", order.AmountCents), "bankTxnRef", "field.invalid"},
		{"交易号超过 64 位", proofInput(paytest.PNG(t, 22), strings.Repeat("A", 65), order.AmountCents), "bankTxnRef", "field.invalid"},
		{"金额为 0", proofInput(paytest.PNG(t, 23), "ABA778899", 0), "declaredAmountCents", "field.must_be_positive"},
		{"付款人超过 100 字", func() payment.SubmitProofInput {
			in := proofInput(paytest.PNG(t, 24), "ABA778899", order.AmountCents)
			in.PayerName = &longName
			return in
		}(), "payerName", "field.too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo, tc.in, testMeta)
			ae := requireAppErr(t, err, apperr.CodeValidation, http.StatusUnprocessableEntity)
			require.Equal(t, tc.key, ae.Fields[tc.field].Key)
		})
	}
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_PROOF'`))
	require.Len(t, env.Store.Puts(), len(cases))
	require.ElementsMatch(t, env.Store.Puts(), env.Store.Deletes())
}

func TestSubmitProofRejectsNonImageBeforeStoring(t *testing.T) {
	env := paytest.NewEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7008, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{})

	_, err := env.Payments.SubmitProof(context.Background(), u, order.OrderNo,
		proofInput([]byte("definitely not an image"), "ABA778899", order.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeFileTypeNotAllowed, http.StatusUnsupportedMediaType)
	require.Empty(t, env.Store.Puts())
}

func TestSubmitProofSameTxnRefConcurrentlyOnlyOneSucceeds(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7009, "Sokha Chan")
	orders := []paytest.OrderRef{
		paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 1}),
		paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 2}),
	}
	images := [][]byte{paytest.PNG(t, 30), paytest.PNG(t, 31)}

	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, len(orders))
	for i, o := range orders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, errs[i] = env.Payments.SubmitProof(ctx, u, o.OrderNo, proofInput(images[i], "ABA-CONCURRENT-01", o.AmountCents), testMeta)
		}()
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for _, err := range errs {
		if err == nil {
			succeeded++
			continue
		}
		ae := requireAppErr(t, err, apperr.CodeProofTxnRefUsed, http.StatusConflict)
		require.Equal(t, apperr.CodeProofTxnRefUsed, ae.Fields["bankTxnRef"].Key)
	}
	require.Equal(t, 1, succeeded)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE bank_txn_ref = 'ABA-CONCURRENT-01'`))
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE status = 'PROOF_SUBMITTED'`))
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE status = 'PENDING_PAYMENT'`))
	require.Len(t, env.Store.Puts(), 2)
	require.Len(t, env.Store.Deletes(), 1)
}

func TestSubmitProofFlagsIdenticalScreenshotOnAnotherOrder(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7010, "Sokha Chan")
	first := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 1})
	second := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 2})
	img := paytest.PNG(t, 40)

	p1, err := env.Payments.SubmitProof(ctx, u, first.OrderNo, proofInput(img, "ABA-FIRST-001", first.AmountCents), testMeta)
	require.NoError(t, err)
	p2, err := env.Payments.SubmitProof(ctx, u, second.OrderNo, proofInput(img, "ABA-SECOND-002", second.AmountCents), testMeta)
	require.NoError(t, err)

	require.False(t, p1.DupFileHit)
	require.True(t, p2.DupFileHit)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND dup_file_hit`, p2.ID))
}

func TestSubmitProofRollbackDeletesStoredFile(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7011, "Sokha Chan")
	first := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 1})
	second := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{IdentOffset: 2})

	_, err := env.Payments.SubmitProof(ctx, u, first.OrderNo, proofInput(paytest.PNG(t, 50), "ABA-DUP-REF-9", first.AmountCents), testMeta)
	require.NoError(t, err)
	_, err = env.Payments.SubmitProof(ctx, u, second.OrderNo, proofInput(paytest.PNG(t, 51), "aba-dup-ref-9", second.AmountCents), testMeta)

	requireAppErr(t, err, apperr.CodeProofTxnRefUsed, http.StatusConflict)
	puts := env.Store.Puts()
	require.Len(t, puts, 2)
	require.Equal(t, []string{puts[1]}, env.Store.Deletes())
	_, openErr := env.Store.Open(ctx, puts[1])
	require.True(t, errors.Is(openErr, storage.ErrNotFound), "回滚后文件应被删除，得到 %v", openErr)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_PROOF'`))
	status, deadline := orderState(t, env, second.ID)
	require.Equal(t, "PENDING_PAYMENT", status)
	require.NotNil(t, deadline)
}

func TestMarkProofSubmittedRejectsOrderNotAwaitingProof(t *testing.T) {
	env := paytest.NewEnv(t)
	ctx := context.Background()
	fx := paytest.SeedEvent(t, env.Pool)
	u := paytest.SeedUser(t, env.Pool, 7012, "Sokha Chan")
	order := paytest.SeedOrder(t, env, fx, u, paytest.OrderSpec{Status: "PROOF_SUBMITTED"})

	tx, err := env.Pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()

	locked, err := env.Orders.LockOrderByNo(ctx, tx, " "+strings.ToLower(order.OrderNo)+" ")
	require.NoError(t, err)
	require.Equal(t, order.ID, locked.ID)
	require.Equal(t, u.ID, locked.BuyerUserID)
	require.Equal(t, fx.AccountID, locked.PaymentAccountID)

	err = env.Orders.MarkProofSubmitted(ctx, tx, order.ID)
	requireAppErr(t, err, apperr.CodeOrderStateConflict, http.StatusConflict)
}
