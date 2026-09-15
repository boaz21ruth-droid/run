package payment

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/runner"
)

func (h *Handlers) AppSubmitProof(ctx context.Context, req apigen.AppSubmitProofRequestObject) (apigen.AppSubmitProofResponseObject, error) {
	u, ok := runner.UserFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in, err := readProofForm(req.Body)
	if err != nil {
		return nil, err
	}
	proof, err := h.svc.SubmitProof(ctx, u, req.OrderNo, in, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AppSubmitProof201JSONResponse(proofToAPI(proof)), nil
}

// readProofForm 逐个读取 multipart part：file 最多读 MaxProofBytes+1 字节（超限由 storage.ReadImage 报 FILE_TOO_LARGE），
// 文本字段各最多 maxTextPartBytes；未知 part 跳过。请求体超过路由级 6 MiB 上限时 http.MaxBytesReader 报错，
// 由 multipartError 映射为 FILE_TOO_LARGE。
func readProofForm(r *multipart.Reader) (SubmitProofInput, error) {
	var in SubmitProofInput
	var file []byte
	haveFile := false
	fields := map[string]string{}
	for {
		part, err := r.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return SubmitProofInput{}, multipartError(err, storage.MaxProofBytes)
		}
		name := part.FormName()
		switch name {
		case "file":
			data, err := io.ReadAll(io.LimitReader(part, storage.MaxProofBytes+1))
			if err != nil {
				return SubmitProofInput{}, multipartError(err, storage.MaxProofBytes)
			}
			file, haveFile = data, true
		case "bankTxnRef", "declaredAmountCents", "declaredPaidAt", "payerName":
			data, err := io.ReadAll(io.LimitReader(part, maxTextPartBytes+1))
			if err != nil {
				return SubmitProofInput{}, multipartError(err, storage.MaxProofBytes)
			}
			if len(data) > maxTextPartBytes {
				return SubmitProofInput{}, validationError().
					WithField(name, "field.too_long", map[string]any{"max": maxTextPartBytes})
			}
			fields[name] = string(data)
		}
		if err := part.Close(); err != nil {
			return SubmitProofInput{}, multipartError(err, storage.MaxProofBytes)
		}
	}

	verr := validationError()
	if haveFile {
		in.File = bytes.NewReader(file)
	} else {
		verr = verr.WithField("file", "field.required", nil)
	}
	in.BankTxnRef = fields["bankTxnRef"]
	if amount := strings.TrimSpace(fields["declaredAmountCents"]); amount == "" {
		verr = verr.WithField("declaredAmountCents", "field.required", nil)
	} else if cents, err := strconv.ParseInt(amount, 10, 64); err != nil {
		verr = verr.WithField("declaredAmountCents", "field.invalid", nil)
	} else {
		in.DeclaredAmountCents = cents
	}
	if v := strings.TrimSpace(fields["declaredPaidAt"]); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			verr = verr.WithField("declaredPaidAt", "field.invalid", nil)
		} else {
			in.DeclaredPaidAt = &t
		}
	}
	if v, ok := fields["payerName"]; ok {
		in.PayerName = &v
	}
	if len(verr.Fields) > 0 {
		return SubmitProofInput{}, verr
	}
	return in, nil
}

func proofToAPI(p Proof) apigen.Proof {
	return apigen.Proof{
		Id:                  p.ID,
		ProofNo:             p.ProofNo,
		OrderId:             p.OrderID,
		OrderNo:             p.OrderNo,
		PaymentAccountId:    p.PaymentAccountID,
		FileId:              p.FileID,
		Status:              apigen.ProofStatus(p.Status),
		BankTxnRef:          p.BankTxnRef,
		DeclaredAmountCents: p.DeclaredAmountCents,
		DeclaredPaidAt:      p.DeclaredPaidAt,
		PayerName:           p.PayerName,
		DupFileHit:          p.DupFileHit,
		RejectCode:          p.RejectCode,
		RejectReason:        p.RejectReason,
		ReviewedBy:          p.ReviewedBy,
		ReviewedAt:          p.ReviewedAt,
		CreatedAt:           p.CreatedAt,
	}
}
