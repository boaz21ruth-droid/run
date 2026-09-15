package httpapi_test

import (
	"bytes"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func TestRunnerUploadsProofWithMultipart(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7101, "Sokha")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})

	body, contentType := proofForm(t, paytest.PNG(t, 42), map[string]string{
		"bankTxnRef":          "aba 5566 77",
		"declaredAmountCents": strconv.FormatInt(order.AmountCents, 10),
		"declaredPaidAt":      "2026-09-14T09:30:00+07:00",
		"payerName":           "SOKHA",
	})
	rec := env.uploadProof(t, order.OrderNo, body, contentType, token)

	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	got := paymentDecode[apigen.Proof](t, rec)
	require.Equal(t, "ABA556677", got.BankTxnRef)
	require.Equal(t, apigen.ProofStatusSUBMITTED, got.Status)
	require.Equal(t, order.OrderNo, got.OrderNo)
	require.Equal(t, order.AmountCents, got.DeclaredAmountCents)
	require.NotNil(t, got.DeclaredPaidAt)
	require.Equal(t, "2026-09-14T02:30:00Z", got.DeclaredPaidAt.UTC().Format(time.RFC3339))
	require.NotNil(t, got.PayerName)
	require.Equal(t, "SOKHA", *got.PayerName)
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED'`, order.ID))
}

func TestProofUploadRejectsBadRequests(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7102, "Sokha")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})
	fields := map[string]string{"bankTxnRef": "ABA556677", "declaredAmountCents": strconv.FormatInt(order.AmountCents, 10)}

	t.Run("非图片返回 415", func(t *testing.T) {
		body, contentType := proofForm(t, []byte("plain text pretending to be a screenshot"), fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusUnsupportedMediaType, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeFileTypeNotAllowed, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	t.Run("图片超过 5 MB 返回 413", func(t *testing.T) {
		big := append(paytest.PNG(t, 43), bytes.Repeat([]byte{0}, 5<<20)...)
		body, contentType := proofForm(t, big, fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeFileTooLarge, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	t.Run("请求体超过 6 MiB 返回 413", func(t *testing.T) {
		huge := append(paytest.PNG(t, 44), bytes.Repeat([]byte{0}, 7<<20)...)
		body, contentType := proofForm(t, huge, fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeFileTooLarge, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	t.Run("缺少文件与金额格式错误返回 422", func(t *testing.T) {
		body, contentType := proofForm(t, nil, map[string]string{"bankTxnRef": "ABA556677", "declaredAmountCents": "12.50"})
		rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
		errBody := paymentDecode[httpx.ErrorBody](t, rec)
		require.Equal(t, apperr.CodeValidation, errBody.Error.Code)
		require.Contains(t, errBody.Error.Fields, "file")
		require.Contains(t, errBody.Error.Fields, "declaredAmountCents")
	})

	t.Run("没有令牌返回 401", func(t *testing.T) {
		body, contentType := proofForm(t, paytest.PNG(t, 45), fields)
		rec := env.uploadProof(t, order.OrderNo, body, contentType, "")
		require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		require.Equal(t, apperr.CodeUnauthenticated, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
	})

	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs`))
	require.Equal(t, 0, paytest.Count(t, env.Pool, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_PROOF'`))
	require.Empty(t, env.Store.Puts())
}
