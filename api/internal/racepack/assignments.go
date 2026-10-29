package racepack

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/racepack/store"
)

// ListStaff 返回全部员工，供给现场角色做指派。
func (s *Service) ListStaff(ctx context.Context) ([]StaffMember, error) {
	rows, err := store.New(s.pool).ListStaff(ctx)
	if err != nil {
		return nil, fmt.Errorf("list staff: %w", err)
	}
	out := make([]StaffMember, 0, len(rows))
	for _, r := range rows {
		out = append(out, StaffMember(r))
	}
	return out, nil
}

// ListAssignments 返回赛事的现场人员指派。
func (s *Service) ListAssignments(ctx context.Context, eventID int64) ([]Assignment, error) {
	q := store.New(s.pool)
	if _, err := q.GetRaceEvent(ctx, eventID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	} else if err != nil {
		return nil, fmt.Errorf("get event %d: %w", eventID, err)
	}
	rows, err := q.ListEventAssignments(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list assignments of event %d: %w", eventID, err)
	}
	out := make([]Assignment, 0, len(rows))
	for _, r := range rows {
		out = append(out, Assignment(r))
	}
	return out, nil
}

// PutAssignment 新增或修改一名现场角色员工对赛事的指派。只接受现场角色：
// 其他角色本来就不看指派，给他们建指派只会让人误以为权限被收窄了。
func (s *Service) PutAssignment(ctx context.Context, actor iam.Staff, eventID, staffID int64, from, until time.Time, enabled bool, meta httpx.Meta) ([]Assignment, error) {
	if !until.After(from) {
		return nil, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	}
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if _, err := q.GetRaceEvent(ctx, eventID); errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		} else if err != nil {
			return fmt.Errorf("get event %d: %w", eventID, err)
		}
		member, err := q.GetStaffRole(ctx, staffID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("get staff %d: %w", staffID, err)
		}
		if !scopedRoles[iam.Role(member.Role)] {
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
		}
		actorID := actor.ID
		if err := q.UpsertEventAssignment(ctx, store.UpsertEventAssignmentParams{
			StaffID: staffID, EventID: eventID, ValidFrom: from.UTC(), ValidUntil: until.UTC(), Enabled: enabled, CreatedBy: &actorID,
		}); err != nil {
			return fmt.Errorf("upsert assignment of staff %d to event %d: %w", staffID, eventID, err)
		}
		role := string(actor.Role)
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "STAFF",
			ActorID:    &actorID,
			ActorRole:  &role,
			Action:     "staff.assign_event",
			EntityType: "staff",
			EntityID:   staffID,
			EventID:    &eventID,
			Summary:    "修改现场人员赛事指派",
			After:      map[string]any{"validFrom": from, "validUntil": until, "enabled": enabled},
			Meta:       meta,
		})
	})
	if err != nil {
		return nil, err
	}
	return s.ListAssignments(ctx, eventID)
}
