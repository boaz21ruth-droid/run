package httpapi_test

import (
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/payment/paytest"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func uploadForReview(t *testing.T, env paymentHTTPEnv, token string, order paytest.OrderRef, img []byte, txnRef string) apigen.Proof {
	t.Helper()
	body, contentType := proofForm(t, img, map[string]string{
		"bankTxnRef":          txnRef,
		"declaredAmountCents": strconv.FormatInt(order.AmountCents, 10),
	})
	rec := env.uploadProof(t, order.OrderNo, body, contentType, token)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	return paymentDecode[apigen.Proof](t, rec)
}

func TestFinanceReviewsProofsOverHTTP(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7601, "Sokha")
	orderA := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{IdentOffset: 1})
	orderB := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{IdentOffset: 2})
	imgA := paytest.PNG(t, 101)
	proofA := uploadForReview(t, env, token, orderA, imgA, "ABA-HTTP-A01")
	proofB := uploadForReview(t, env, token, orderB, paytest.PNG(t, 102), "ABA-HTTP-B02")
	finance := env.staffCookie(t, iam.RoleFinance, "finance.review")

	rec := env.adminRequest(t, http.MethodGet, "/api/admin/proofs", nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	queue := paymentDecode[apigen.ProofQueue](t, rec)
	require.Len(t, queue.Items, 2)
	require.Equal(t, proofA.Id, queue.Items[0].Proof.Id)
	require.Equal(t, proofB.Id, queue.Items[1].Proof.Id)
	require.Equal(t, orderA.AmountCents, queue.Items[0].AmountCents)
	require.False(t, queue.Items[0].OverSla)

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/proofs/%d", proofA.Id), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	detail := paymentDecode[apigen.ProofDetail](t, rec)
	require.Equal(t, orderA.OrderNo, detail.Order.OrderNo)
	require.Equal(t, apigen.AdminOrderDetailStatusPROOFSUBMITTED, detail.Order.Status)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proofA.Id), map[string]any{
		"receivedAmountCents": orderA.AmountCents - 1,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	tooLow := paymentDecode[httpx.ErrorBody](t, rec)
	require.Equal(t, apperr.CodeReceivedAmountTooLow, tooLow.Error.Code)
	require.Contains(t, tooLow.Error.Fields, "receivedAmountCents")

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proofA.Id), map[string]any{
		"receivedAmountCents": orderA.AmountCents,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	approved := paymentDecode[apigen.ProofDetail](t, rec)
	require.Equal(t, apigen.ProofStatusAPPROVED, approved.Proof.Status)
	require.Equal(t, apigen.AdminOrderDetailStatusPAID, approved.Order.Status)
	require.Len(t, approved.Order.Receipts, 1)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proofA.Id), map[string]any{
		"receivedAmountCents": orderA.AmountCents,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, finance)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeOrderStateConflict, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/reject", proofB.Id), map[string]any{
		"rejectCode": "OTHER",
	}, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, paymentDecode[httpx.ErrorBody](t, rec).Error.Fields, "rejectReason")

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/reject", proofB.Id), map[string]any{
		"rejectCode":   "UNREADABLE",
		"rejectReason": "截图模糊",
	}, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rejected := paymentDecode[apigen.ProofDetail](t, rec)
	require.Equal(t, apigen.ProofStatusREJECTED, rejected.Proof.Status)
	require.Equal(t, apigen.AdminOrderDetailStatusPROOFREJECTED, rejected.Order.Status)
	require.NotNil(t, rejected.Order.DeadlineAt)

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/files/%d", proofA.FileId), nil, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "image/png", rec.Header().Get("Content-Type"))
	require.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	require.Equal(t, imgA, rec.Body.Bytes())

	rec = env.adminRequest(t, http.MethodGet, fmt.Sprintf("/api/admin/files/%d", fx.QRFileID), nil, finance)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeNotFound, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)
}

func TestProofReviewPermissions(t *testing.T) {
	env := newPaymentHTTPEnv(t)
	fx := paytest.SeedEvent(t, env.Pool)
	token, u := env.runnerToken(t, 7602, "Sokha")
	order := paytest.SeedOrder(t, env.Env, fx, u, paytest.OrderSpec{})
	proof := uploadForReview(t, env, token, order, paytest.PNG(t, 103), "ABA-HTTP-C03")
	support := env.staffCookie(t, iam.RoleSupport, "support.review")
	photographer := env.staffCookie(t, iam.RolePhotographer, "photog.review")

	for _, path := range []string{
		"/api/admin/proofs",
		fmt.Sprintf("/api/admin/proofs/%d", proof.Id),
		fmt.Sprintf("/api/admin/files/%d", proof.FileId),
	} {
		rec := env.adminRequest(t, http.MethodGet, path, nil, support)
		require.Equal(t, http.StatusOK, rec.Code, "SUPPORT 读 %s: %s", path, rec.Body.String())
		rec = env.adminRequest(t, http.MethodGet, path, nil, photographer)
		require.Equal(t, http.StatusForbidden, rec.Code, "PHOTOGRAPHER 读 %s: %s", path, rec.Body.String())
		rec = env.adminRequest(t, http.MethodGet, path, nil, nil)
		require.Equal(t, http.StatusUnauthorized, rec.Code, "未登录读 %s: %s", path, rec.Body.String())
	}

	rec := env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/approve", proof.Id), map[string]any{
		"receivedAmountCents": order.AmountCents,
		"receivedAt":          env.Clock.Now().Format(time.RFC3339),
	}, support)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeForbidden, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.adminRequest(t, http.MethodPost, fmt.Sprintf("/api/admin/proofs/%d/reject", proof.Id), map[string]any{
		"rejectCode": "UNREADABLE",
	}, support)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeForbidden, paymentDecode[httpx.ErrorBody](t, rec).Error.Code)

	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM payment_proofs WHERE id = $1 AND status = 'SUBMITTED'`, proof.Id))
	require.Equal(t, 1, paytest.Count(t, env.Pool, `SELECT count(*) FROM reg_orders WHERE id = $1 AND status = 'PROOF_SUBMITTED'`, order.ID))
}
