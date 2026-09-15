package payment_test

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
	"werun/api/internal/notify/notifytest"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
	"werun/api/internal/registration/regtest"
	"werun/api/internal/runner"
)

type proofNotifyFixture struct {
	env     *regtest.Env
	pay     *payment.Service
	user    runner.User
	order   registration.OrderDetail
	proof   payment.Proof
	finance iam.Staff
}

func newProofNotifyFixture(t *testing.T, telegramID int64, idNo string) proofNotifyFixture {
	t.Helper()
	env := regtest.New(t)
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	pay := payment.NewService(env.Pool, disk, env.Orders, env.Notifier, env.Clock.Now)
	user := env.NewRunner(t, telegramID, "en")
	order := env.CreateOrder(t, user, idNo, "")
	proof, err := pay.SubmitProof(context.Background(), user, order.OrderNo, payment.SubmitProofInput{
		File:                bytes.NewReader(regtest.PNG(t)),
		BankTxnRef:          "TXN" + idNo,
		DeclaredAmountCents: order.AmountCents,
	}, httpx.Meta{})
	require.NoError(t, err)
	finance := env.NewStaff(t, iam.RoleFinance, fmt.Sprintf("finance.%d", telegramID))
	return proofNotifyFixture{env: env, pay: pay, user: user, order: order, proof: proof, finance: finance}
}

func TestApproveProofEnqueuesApprovedNotification(t *testing.T) {
	f := newProofNotifyFixture(t, 720001, "P7200011")

	_, err := f.pay.ApproveProof(context.Background(), f.finance, f.proof.ID, payment.ApproveInput{
		ReceivedAmountCents: f.order.AmountCents,
		ReceivedAt:          f.env.Clock.Now(),
	}, httpx.Meta{})

	require.NoError(t, err)
	require.Equal(t, 1, f.env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 1, f.env.CountRows(t,
		`SELECT count(*) FROM notification_logs WHERE template = 'proof_approved' AND locale = 'en' AND dedupe_key = $1`,
		fmt.Sprintf("proof_approved:%d:%d", f.order.ID, f.proof.ID)))
	require.Equal(t,
		fmt.Sprintf("Payment confirmed\nEvent: %s\nOrder: %s\nYour registration is confirmed. Open the order to see your race ticket.",
			regtest.EventNameEN, f.order.OrderNo),
		f.env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, notifytest.AppBaseURL+"/orders/"+f.order.OrderNo,
		f.env.QueryString(t, `SELECT args->'button'->>'url' FROM river_job WHERE kind = 'notify_send'`))
}

func TestRejectProofEnqueuesRejectedNotification(t *testing.T) {
	f := newProofNotifyFixture(t, 720002, "P7200021")
	ctx := context.Background()
	note := "Photo is blurry"

	_, err := f.pay.RejectProof(ctx, f.finance, f.proof.ID, payment.RejectInput{Code: "UNREADABLE", Reason: &note}, httpx.Meta{})

	require.NoError(t, err)
	var deadline time.Time
	require.NoError(t, f.env.Pool.QueryRow(ctx, `SELECT deadline_at FROM reg_orders WHERE id = $1`, f.order.ID).Scan(&deadline))
	phnomPenh, err := time.LoadLocation("Asia/Phnom_Penh")
	require.NoError(t, err)
	require.Equal(t, 1, f.env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 1, f.env.CountRows(t,
		`SELECT count(*) FROM notification_logs WHERE template = 'proof_rejected' AND dedupe_key = $1`,
		fmt.Sprintf("proof_rejected:%d:%d", f.order.ID, f.proof.ID)))
	require.Equal(t,
		fmt.Sprintf("Payment proof not accepted\nEvent: %s\nOrder: %s\nReason: Screenshot is unreadable\nPhoto is blurry\nPlease upload a new proof before %s, otherwise the order will be cancelled automatically.",
			regtest.EventNameEN, f.order.OrderNo, deadline.In(phnomPenh).Format("2006-01-02 15:04")),
		f.env.QueryString(t, `SELECT args->>'text' FROM river_job WHERE kind = 'notify_send'`))
}

func TestApproveProofFailureEnqueuesNothing(t *testing.T) {
	f := newProofNotifyFixture(t, 720003, "P7200031")

	_, err := f.pay.ApproveProof(context.Background(), f.finance, f.proof.ID, payment.ApproveInput{
		ReceivedAmountCents: f.order.AmountCents - 1,
		ReceivedAt:          f.env.Clock.Now(),
	}, httpx.Meta{})

	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	require.Equal(t, apperr.CodeReceivedAmountTooLow, ae.Code)
	require.Equal(t, 0, f.env.CountRows(t, `SELECT count(*) FROM river_job WHERE kind = 'notify_send'`))
	require.Equal(t, 0, f.env.CountRows(t, `SELECT count(*) FROM notification_logs`))
}
