package registration

import (
	"context"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
)

func qualificationToAPI(q *ParticipantQualification) *apigen.ParticipantQualification {
	if q == nil {
		return nil
	}
	return &apigen.ParticipantQualification{
		Status:              apigen.QualificationStatus(q.Status),
		AppliedCategoryName: localizedToAPI(q.AppliedCategoryName),
		ReviewNote:          q.ReviewNote,
	}
}

func qualificationFromAPI(q *apigen.ParticipantQualification) *ParticipantQualification {
	if q == nil {
		return nil
	}
	return &ParticipantQualification{
		Status:              string(q.Status),
		AppliedCategoryName: localizedFromAPI(q.AppliedCategoryName),
		ReviewNote:          q.ReviewNote,
	}
}

func proofToAPI(p QualificationProof) apigen.AdminQualificationProof {
	return apigen.AdminQualificationProof{
		Id:                   p.ID,
		Status:               apigen.QualificationStatus(p.Status),
		RegistrationId:       p.RegistrationID,
		RegNo:                p.RegNo,
		FullName:             p.FullName,
		RegistrationStatus:   apigen.AdminQualificationProofRegistrationStatus(p.RegistrationStatus),
		CategoryId:           p.CategoryID,
		CategoryCode:         p.CategoryCode,
		FallbackCategoryCode: p.FallbackCategoryCode,
		BestTimeMs:           p.BestTimeMs,
		MaxTimeMs:            p.MaxTimeMs,
		Source:               p.Source,
		ProofUrl:             p.ProofURL,
		ReviewNote:           p.ReviewNote,
		MovedToCategoryCode:  p.MovedToCategoryCode,
		ReviewedAt:           p.ReviewedAt,
		CreatedAt:            p.CreatedAt,
	}
}

func (h *Handlers) AdminListQualificationProofs(ctx context.Context, req apigen.AdminListQualificationProofsRequestObject) (apigen.AdminListQualificationProofsResponseObject, error) {
	items, err := h.svc.ListQualificationProofs(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	out := make([]apigen.AdminQualificationProof, 0, len(items))
	for _, p := range items {
		out = append(out, proofToAPI(p))
	}
	return apigen.AdminListQualificationProofs200JSONResponse{Items: out}, nil
}

func (h *Handlers) AdminApproveQualificationProof(ctx context.Context, req apigen.AdminApproveQualificationProofRequestObject) (apigen.AdminApproveQualificationProofResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	p, err := h.svc.ApproveQualificationProof(ctx, actor, req.Id)
	if err != nil {
		return nil, err
	}
	return apigen.AdminApproveQualificationProof200JSONResponse(proofToAPI(p)), nil
}

func (h *Handlers) AdminRejectQualificationProof(ctx context.Context, req apigen.AdminRejectQualificationProofRequestObject) (apigen.AdminRejectQualificationProofResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	var note string
	if req.Body != nil && req.Body.Note != nil {
		note = *req.Body.Note
	}
	p, err := h.svc.RejectQualificationProof(ctx, actor, req.Id, note)
	if err != nil {
		return nil, err
	}
	return apigen.AdminRejectQualificationProof200JSONResponse(proofToAPI(p)), nil
}
