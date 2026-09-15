package payment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/payment/store"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/idgen"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
	"werun/api/internal/runner"
)

func init() {
	apperr.RegisterConstraint("payment_proofs_txn_ref_uniq", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeProofTxnRefUsed).
			WithField("bankTxnRef", apperr.CodeProofTxnRefUsed, nil)
	})
}

const (
	constraintProofNo = "payment_proofs_proof_no_key"

	minTxnRefLen    = 4
	maxTxnRefLen    = 64
	maxPayerNameLen = 100
)

// SubmitProofInput 是跑者上传凭证的输入。File 为原始图片流，其余为表单字段原值。
type SubmitProofInput struct {
	File                io.Reader
	BankTxnRef          string
	DeclaredAmountCents int64
	DeclaredPaidAt      *time.Time
	PayerName           *string
}

// Proof 是一份付款凭证。OrderNo 取自所属报名订单。
type Proof struct {
	ID, OrderID, PaymentAccountID, FileID int64
	ProofNo, OrderNo, BankTxnRef, Status  string
	DeclaredAmountCents                   int64
	DeclaredPaidAt                        *time.Time
	PayerName                             *string
	DupFileHit                            bool
	RejectCode                            *string
	RejectReason                          *string
	ReviewedBy                            *int64
	ReviewedAt                            *time.Time
	CreatedAt                             time.Time
}

// SubmitProof 按 spec 6.2 上传凭证：事务外读图并写存储，事务内锁单、校验、写文件与凭证、订单改为审核中、写审计。
// 事务失败时尽力删除已写入存储的文件，删除失败只记日志。
func (s *Service) SubmitProof(ctx context.Context, u runner.User, orderNo string, in SubmitProofInput, meta httpx.Meta) (Proof, error) {
	if in.File == nil {
		return Proof{}, validationError().WithField("file", "field.required", nil)
	}
	img, err := storage.ReadImage(in.File, storage.MaxProofBytes)
	if err != nil {
		return Proof{}, err
	}
	now := s.now()
	key := storage.NewKey(now, img.Ext)
	if err := s.files.Put(ctx, key, bytes.NewReader(img.Data)); err != nil {
		return Proof{}, fmt.Errorf("store proof file: %w", err)
	}

	var out Proof
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		order, err := s.orders.LockOrderByNo(ctx, tx, orderNo)
		if err != nil {
			return err
		}
		if order.BuyerUserID != u.ID {
			return apperr.New(http.StatusNotFound, apperr.CodeOrderNotFound)
		}
		if order.Status != registration.StatusPendingPayment && order.Status != registration.StatusProofRejected {
			return apperr.New(http.StatusConflict, apperr.CodeOrderStateConflict)
		}
		if order.DeadlineAt != nil && !order.DeadlineAt.After(now) {
			return apperr.New(http.StatusConflict, apperr.CodeOrderExpired)
		}

		txnRef := normalizeTxnRef(in.BankTxnRef)
		payerName := trimOptional(in.PayerName)
		if err := validateSubmit(txnRef, in.DeclaredAmountCents, payerName); err != nil {
			return err
		}

		fileID, err := storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey:     key,
			Visibility:     storage.VisibilityPrivate,
			Purpose:        storage.PurposePaymentProof,
			Image:          img,
			UploadedByType: "USER",
			UploadedByID:   u.ID,
		})
		if err != nil {
			return fmt.Errorf("insert proof file: %w", err)
		}
		dups, err := storage.CountOtherFilesWithSHA256(ctx, tx, img.SHA256[:], storage.PurposePaymentProof, fileID)
		if err != nil {
			return fmt.Errorf("count duplicate proof files: %w", err)
		}

		var declaredPaidAt *time.Time
		if in.DeclaredPaidAt != nil {
			t := in.DeclaredPaidAt.UTC()
			declaredPaidAt = &t
		}
		var row store.PaymentProof
		err = idgen.Retry(constraintProofNo, func() error {
			return inSavepoint(ctx, tx, func(q *store.Queries) error {
				var insertErr error
				row, insertErr = q.InsertPaymentProof(ctx, store.InsertPaymentProofParams{
					ProofNo:             idgen.Code(idgen.PrefixProof),
					RegOrderID:          order.ID,
					PaymentAccountID:    order.PaymentAccountID,
					FileID:              fileID,
					SubmittedByUserID:   u.ID,
					DeclaredAmountCents: in.DeclaredAmountCents,
					BankTxnRef:          txnRef,
					DeclaredPaidAt:      declaredPaidAt,
					PayerName:           payerName,
					DupFileHit:          dups > 0,
				})
				return insertErr
			})
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		if err := s.orders.MarkProofSubmitted(ctx, tx, order.ID); err != nil {
			return err
		}

		out = proofFromRow(row, order.OrderNo)
		actorID := u.ID
		eventID := order.EventID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:   "USER",
			ActorID:     &actorID,
			Action:      "payment_proof.submit",
			EntityType:  "payment_proof",
			EntityID:    out.ID,
			EventID:     &eventID,
			IsFinancial: true,
			Summary:     fmt.Sprintf("订单 %s 上传付款凭证 %s", order.OrderNo, out.ProofNo),
			Before:      map[string]any{"orderStatus": order.Status},
			After: map[string]any{
				"orderNo":             order.OrderNo,
				"orderStatus":         registration.StatusProofSubmitted,
				"proofNo":             out.ProofNo,
				"bankTxnRef":          out.BankTxnRef,
				"declaredAmountCents": out.DeclaredAmountCents,
				"dupFileHit":          out.DupFileHit,
				"fileId":              fileID,
			},
			Meta: meta,
		})
	})
	if err != nil {
		s.discardFile(ctx, key)
		return Proof{}, err
	}
	return out, nil
}

func validateSubmit(txnRef string, declaredAmountCents int64, payerName *string) error {
	verr := validationError()
	switch n := utf8.RuneCountInString(txnRef); {
	case n == 0:
		verr = verr.WithField("bankTxnRef", "field.required", nil)
	case n < minTxnRefLen || n > maxTxnRefLen:
		verr = verr.WithField("bankTxnRef", "field.invalid", nil)
	}
	if declaredAmountCents <= 0 {
		verr = verr.WithField("declaredAmountCents", "field.must_be_positive", nil)
	}
	if payerName != nil && utf8.RuneCountInString(*payerName) > maxPayerNameLen {
		verr = verr.WithField("payerName", "field.too_long", map[string]any{"max": maxPayerNameLen})
	}
	if len(verr.Fields) > 0 {
		return verr
	}
	return nil
}

// normalizeTxnRef 去掉所有 Unicode 空白后转大写。
func normalizeTxnRef(s string) string {
	return strings.ToUpper(strings.Join(strings.Fields(s), ""))
}

func trimOptional(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

// inSavepoint 在保存点里执行 fn：失败时回滚到保存点，外层事务仍可继续使用（供 idgen.Retry 重试）。
// 收款包内所有 idgen.Retry 的插入都走这一个辅助函数。
func inSavepoint(ctx context.Context, tx pgx.Tx, fn func(q *store.Queries) error) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin savepoint: %w", err)
	}
	if err := fn(store.New(sp)); err != nil {
		if rbErr := sp.Rollback(ctx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
			return errors.Join(err, fmt.Errorf("rollback savepoint: %w", rbErr))
		}
		return err
	}
	if err := sp.Commit(ctx); err != nil {
		return fmt.Errorf("release savepoint: %w", err)
	}
	return nil
}

func proofFromRow(r store.PaymentProof, orderNo string) Proof {
	p := Proof{
		ID:                  r.ID,
		PaymentAccountID:    r.PaymentAccountID,
		FileID:              r.FileID,
		ProofNo:             r.ProofNo,
		OrderNo:             orderNo,
		BankTxnRef:          r.BankTxnRef,
		Status:              r.Status,
		DeclaredAmountCents: r.DeclaredAmountCents,
		DeclaredPaidAt:      r.DeclaredPaidAt,
		PayerName:           r.PayerName,
		DupFileHit:          r.DupFileHit,
		RejectCode:          r.RejectCode,
		RejectReason:        r.RejectReason,
		ReviewedBy:          r.ReviewedBy,
		ReviewedAt:          r.ReviewedAt,
		CreatedAt:           r.CreatedAt,
	}
	if r.RegOrderID != nil {
		p.OrderID = *r.RegOrderID
	}
	return p
}
