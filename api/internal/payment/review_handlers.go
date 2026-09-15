package payment

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/registration"
)

func (h *Handlers) AdminListProofs(ctx context.Context, req apigen.AdminListProofsRequestObject) (apigen.AdminListProofsResponseObject, error) {
	status := ""
	if req.Params.Status != nil {
		status = string(*req.Params.Status)
	}
	items, err := h.svc.ListProofs(ctx, status)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.ProofQueueItem, 0, len(items))
	for _, it := range items {
		out = append(out, apigen.ProofQueueItem{
			Proof:        proofToAPI(it.Proof),
			AmountCents:  it.AmountCents,
			EventName:    proofTextToAPI(it.EventName),
			WaitingSince: it.WaitingSince,
			OverSla:      it.OverSLA,
		})
	}
	return apigen.AdminListProofs200JSONResponse{Items: out}, nil
}

func (h *Handlers) AdminGetProof(ctx context.Context, req apigen.AdminGetProofRequestObject) (apigen.AdminGetProofResponseObject, error) {
	d, err := h.svc.GetProof(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminGetProof200JSONResponse(proofDetailToAPI(d)), nil
}

func (h *Handlers) AdminApproveProof(ctx context.Context, req apigen.AdminApproveProofRequestObject) (apigen.AdminApproveProofResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	d, err := h.svc.ApproveProof(ctx, actor, req.Id, ApproveInput{
		ReceivedAmountCents: req.Body.ReceivedAmountCents,
		ReceivedAt:          req.Body.ReceivedAt,
		Note:                req.Body.Note,
	}, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminApproveProof200JSONResponse(proofDetailToAPI(d)), nil
}

func (h *Handlers) AdminRejectProof(ctx context.Context, req apigen.AdminRejectProofRequestObject) (apigen.AdminRejectProofResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	d, err := h.svc.RejectProof(ctx, actor, req.Id, RejectInput{
		Code:   string(req.Body.RejectCode),
		Reason: req.Body.RejectReason,
	}, httpx.MetaOf(ctx))
	if err != nil {
		return nil, err
	}
	return apigen.AdminRejectProof200JSONResponse(proofDetailToAPI(d)), nil
}

func (h *Handlers) AdminGetFile(ctx context.Context, req apigen.AdminGetFileRequestObject) (apigen.AdminGetFileResponseObject, error) {
	file, rc, err := h.svc.OpenProofFile(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	// 私有凭证截图不允许被任何缓存保存；响应头不在 OpenAPI 中声明，生成的响应写出前由 gin 带上
	if c, ok := httpx.Gin(ctx); ok {
		c.Header("Cache-Control", "private, no-store")
	}
	return apigen.AdminGetFile200ImageResponse{Body: rc, ContentType: file.MIME, ContentLength: file.SizeBytes}, nil
}

func proofDetailToAPI(d ProofDetail) apigen.ProofDetail {
	return apigen.ProofDetail{Proof: proofToAPI(d.Proof), Order: registration.AdminOrderDetailToAPI(d.Order)}
}

func proofTextToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}
