package registration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/registration/store"
)

const (
	maxQualifyTimeMs    = 24 * 60 * 60 * 1000
	maxProofSourceLen   = 100
	maxProofURLLen      = 300
	maxQualifyReviewLen = 200
)

func normalizeQualification(in QualificationInput) QualificationInput {
	return QualificationInput{
		BestTimeMs: in.BestTimeMs,
		Source:     strings.TrimSpace(in.Source),
		ProofURL:   strings.TrimSpace(in.ProofURL),
	}
}

// validateQualification 校验成绩证明的格式；字段错误挂在 participants[i].bestTimeMs / proofSource / proofUrl。
func validateQualification(fe *fieldErrors, in QualificationInput, prefix string) {
	if in.BestTimeMs <= 0 || in.BestTimeMs > maxQualifyTimeMs {
		fe.add(prefix+"bestTimeMs", "field.invalid", nil)
	}
	switch {
	case in.Source == "":
		fe.add(prefix+"proofSource", "field.required", nil)
	case utf8.RuneCountInString(in.Source) > maxProofSourceLen:
		fe.add(prefix+"proofSource", "field.too_long", map[string]any{"max": maxProofSourceLen})
	}
	switch {
	case in.ProofURL == "":
		fe.add(prefix+"proofUrl", "field.required", nil)
	case len(in.ProofURL) > maxProofURLLen:
		fe.add(prefix+"proofUrl", "field.too_long", map[string]any{"max": maxProofURLLen})
	case !strings.HasPrefix(in.ProofURL, "https://") && !strings.HasPrefix(in.ProofURL, "http://"):
		fe.add(prefix+"proofUrl", "field.url_format", nil)
	}
}

// checkQualifications 对报精英组的参赛人要求成绩证明，自报成绩不得慢于组别上限。
// 返回与参赛人一一对应的待保存证明；普通组为 nil（带了也丢弃）。
func checkQualifications(ctx context.Context, q *store.Queries, eventID int64, parts []OrderParticipantInput) ([]*QualificationInput, error) {
	rows, err := q.ListCategoryQualifications(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list category qualifications: %w", err)
	}
	type rule struct {
		required bool
		maxMs    *int32
	}
	rules := make(map[int64]rule, len(rows))
	for _, r := range rows {
		rules[r.ID] = rule{required: r.QualifyRequired, maxMs: r.QualifyMaxMs}
	}
	fe := newFieldErrors()
	out := make([]*QualificationInput, len(parts))
	for i, p := range parts {
		r := rules[p.CategoryID]
		if !r.required {
			continue
		}
		prefix := fmt.Sprintf("participants[%d].", i)
		if p.Qualification == nil {
			fe.add(prefix+"bestTimeMs", "field.required", nil)
			continue
		}
		if r.maxMs != nil && p.Qualification.BestTimeMs > *r.maxMs {
			fe.add(prefix+"bestTimeMs", "field.qualify_too_slow", map[string]any{"max": formatDuration(*r.maxMs)})
			continue
		}
		out[i] = p.Qualification
	}
	if err := fe.result(); err != nil {
		return nil, err
	}
	return out, nil
}

// formatDuration 把毫秒格式化为 h:mm:ss（不足一小时为 m:ss）。
func formatDuration(ms int32) string {
	total := ms / 1000
	h, m, s := total/3600, total%3600/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

// QualificationProof 是后台核验列表的一行。
type QualificationProof struct {
	ID                   int64
	Status               string
	RegistrationID       int64
	RegNo, FullName      string
	RegistrationStatus   string
	CategoryID           int64
	CategoryCode         string
	FallbackCategoryCode *string
	BestTimeMs           int32
	MaxTimeMs            *int32
	Source, ProofURL     string
	ReviewNote           *string
	MovedToCategoryCode  *string
	ReviewedAt           *time.Time
	CreatedAt            time.Time
}

// ListQualificationProofs 返回赛事的资格证明，待核验在前。
func (s *Service) ListQualificationProofs(ctx context.Context, eventID int64) ([]QualificationProof, error) {
	rows, err := store.New(s.pool).ListQualificationProofs(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list qualification proofs of event %d: %w", eventID, err)
	}
	out := make([]QualificationProof, 0, len(rows))
	for _, r := range rows {
		out = append(out, proofFromRow(r))
	}
	return out, nil
}

// ApproveQualificationProof 核验通过：只改证明状态。
func (s *Service) ApproveQualificationProof(ctx context.Context, actor iam.Staff, id int64) (QualificationProof, error) {
	return s.reviewQualification(ctx, actor, id, func(q *store.Queries, row store.LockQualificationProofRow, now time.Time) (string, map[string]any, error) {
		if err := q.ApproveQualificationProof(ctx, store.ApproveQualificationProofParams{
			ReviewedBy: &actor.ID, ReviewedAt: &now, ID: row.ID,
		}); err != nil {
			return "", nil, fmt.Errorf("approve qualification proof %d: %w", row.ID, err)
		}
		return "qualification.approve", map[string]any{"status": QualifyApproved}, nil
	})
}

// RejectQualificationProof 核验不通过：报名转到该组设置的公开组，从原组搬一个已确认名额过去。
// 只在报名已确认后进行——此时名额已计入 used_count，下单预留与超时释放按 order_participants 的快照组别计数，不会再碰。
// 已分配号码布的报名须先作废号码布（号码段按组别划分）。价格不同时差价由财务按退款流程处理。
func (s *Service) RejectQualificationProof(ctx context.Context, actor iam.Staff, id int64, note string) (QualificationProof, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxQualifyReviewLen {
		return QualificationProof{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("note", "field.too_long", map[string]any{"max": maxQualifyReviewLen})
	}
	return s.reviewQualification(ctx, actor, id, func(q *store.Queries, row store.LockQualificationProofRow, now time.Time) (string, map[string]any, error) {
		if row.FallbackCategoryID == nil {
			return "", nil, apperr.New(http.StatusConflict, apperr.CodeQualifyNoFallback)
		}
		to := *row.FallbackCategoryID
		bibs, err := q.CountAssignedBibs(ctx, &row.RegistrationID)
		if err != nil {
			return "", nil, fmt.Errorf("count bibs of registration %d: %w", row.RegistrationID, err)
		}
		if bibs > 0 {
			return "", nil, apperr.New(http.StatusConflict, apperr.CodeQualifyBibAssigned)
		}
		if err := q.LockCategoryPair(ctx, store.LockCategoryPairParams{FromID: row.CurrentCategoryID, ToID: to}); err != nil {
			return "", nil, fmt.Errorf("lock categories: %w", err)
		}
		taken, err := q.TakeUsedSeat(ctx, to)
		if err != nil {
			return "", nil, fmt.Errorf("take seat in category %d: %w", to, err)
		}
		if taken != 1 {
			return "", nil, apperr.New(http.StatusConflict, apperr.CodeQualifyFallbackFull)
		}
		released, err := q.ReleaseUsedSeat(ctx, row.CurrentCategoryID)
		if err != nil {
			return "", nil, fmt.Errorf("release seat in category %d: %w", row.CurrentCategoryID, err)
		}
		if released != 1 {
			return "", nil, fmt.Errorf("category %d has no used seat to release", row.CurrentCategoryID)
		}
		if err := q.MoveRegistrationCategory(ctx, store.MoveRegistrationCategoryParams{CategoryID: to, ID: row.RegistrationID}); err != nil {
			return "", nil, fmt.Errorf("move registration %d: %w", row.RegistrationID, err)
		}
		var reviewNote *string
		if note != "" {
			reviewNote = &note
		}
		if err := q.RejectQualificationProof(ctx, store.RejectQualificationProofParams{
			ReviewNote: reviewNote, MovedToCategoryID: &to, ReviewedBy: &actor.ID, ReviewedAt: &now, ID: row.ID,
		}); err != nil {
			return "", nil, fmt.Errorf("reject qualification proof %d: %w", row.ID, err)
		}
		return "qualification.reject", map[string]any{
			"status": QualifyRejected, "fromCategoryId": row.CurrentCategoryID, "toCategoryId": to, "note": note,
		}, nil
	})
}

type reviewFunc func(q *store.Queries, row store.LockQualificationProofRow, now time.Time) (action string, after map[string]any, err error)

// reviewQualification 锁住证明与报名行，检查仍待核验、报名已确认，执行 apply 并写审计。
func (s *Service) reviewQualification(ctx context.Context, actor iam.Staff, id int64, apply reviewFunc) (QualificationProof, error) {
	var out QualificationProof
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.LockQualificationProof(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock qualification proof %d: %w", id, err)
		}
		if row.Status != QualifyPending {
			return apperr.New(http.StatusConflict, apperr.CodeQualifyReviewed)
		}
		if row.RegistrationStatus != RegistrationConfirmed {
			return apperr.New(http.StatusConflict, apperr.CodeQualifyNotConfirmed)
		}
		action, after, err := apply(q, row, s.now().UTC())
		if err != nil {
			return err
		}
		loaded, err := q.GetQualificationProof(ctx, id)
		if err != nil {
			return fmt.Errorf("reload qualification proof %d: %w", id, err)
		}
		out = proofFromRow(store.ListQualificationProofsRow(loaded))

		actorID := actor.ID
		role := string(actor.Role)
		eventID := row.EventID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "STAFF",
			ActorID:    &actorID,
			ActorRole:  &role,
			Action:     action,
			EntityType: "registration",
			EntityID:   row.RegistrationID,
			EventID:    &eventID,
			Summary:    fmt.Sprintf("精英组资格核验 %s：%s", out.RegNo, out.Status),
			After:      after,
			Meta:       httpx.MetaOf(ctx),
		})
	})
	if err != nil {
		return QualificationProof{}, err
	}
	return out, nil
}

func proofFromRow(r store.ListQualificationProofsRow) QualificationProof {
	return QualificationProof{
		ID:                   r.ID,
		Status:               r.Status,
		RegistrationID:       r.RegistrationID,
		RegNo:                r.RegNo,
		FullName:             r.FullName,
		RegistrationStatus:   r.RegistrationStatus,
		CategoryID:           r.CategoryID,
		CategoryCode:         r.CategoryCode,
		FallbackCategoryCode: r.FallbackCategoryCode,
		BestTimeMs:           r.BestTimeMs,
		MaxTimeMs:            r.QualifyMaxMs,
		Source:               r.Source,
		ProofURL:             r.ProofUrl,
		ReviewNote:           r.ReviewNote,
		MovedToCategoryCode:  r.MovedToCategoryCode,
		ReviewedAt:           r.ReviewedAt,
		CreatedAt:            r.CreatedAt,
	}
}
