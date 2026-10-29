package racepack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/racepack/store"
)

// Service 是领物核销站的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建领物服务。
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service {
	return &Service{pool: pool, now: now}
}

// scopedRoles 只能操作被指派赛事的现场角色（D-019）。
var scopedRoles = map[iam.Role]bool{
	iam.RolePhotographer:   true,
	iam.RoleRaceSupervisor: true,
	iam.RoleRaceStaff:      true,
}

// checkScope：现场角色必须被指派到该赛事、启用且在有效期内，否则 FORBIDDEN。
// 其他角色按权限矩阵放行，不看指派。
func (s *Service) checkScope(ctx context.Context, q *store.Queries, actor iam.Staff, eventID int64) error {
	if !scopedRoles[actor.Role] {
		return nil
	}
	ok, err := q.ActiveAssignment(ctx, store.ActiveAssignmentParams{StaffID: actor.ID, EventID: eventID, Now: s.now().UTC()})
	if err != nil {
		return fmt.Errorf("check assignment of staff %d to event %d: %w", actor.ID, eventID, err)
	}
	if !ok {
		return apperr.New(http.StatusForbidden, apperr.CodeForbidden)
	}
	return nil
}

// ListEvents 返回可操作的赛事：现场角色只看被指派且在有效期内的，其他角色看全部已发布的比赛。
func (s *Service) ListEvents(ctx context.Context, actor iam.Staff) ([]Event, error) {
	q := store.New(s.pool)
	var out []Event
	if scopedRoles[actor.Role] {
		rows, err := q.ListAssignedRaceEvents(ctx, store.ListAssignedRaceEventsParams{StaffID: actor.ID, Now: s.now().UTC()})
		if err != nil {
			return nil, fmt.Errorf("list assigned events: %w", err)
		}
		for _, r := range rows {
			ev, err := eventOf(r.ID, r.Name, r.City, r.RaceDate, r.Timezone)
			if err != nil {
				return nil, err
			}
			out = append(out, ev)
		}
		return out, nil
	}
	rows, err := q.ListAllRaceEvents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list race events: %w", err)
	}
	for _, r := range rows {
		ev, err := eventOf(r.ID, r.Name, r.City, r.RaceDate, r.Timezone)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, nil
}

// Station 返回领物进度、最近发放，q 非空时附带搜索结果。
func (s *Service) Station(ctx context.Context, actor iam.Staff, eventID int64, query string) (Station, error) {
	q := store.New(s.pool)
	row, err := q.GetRaceEvent(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (row.EventType != "RACE" || row.Status != "PUBLISHED")) {
		return Station{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return Station{}, fmt.Errorf("get event %d: %w", eventID, err)
	}
	if err := s.checkScope(ctx, q, actor, eventID); err != nil {
		return Station{}, err
	}
	ev, err := eventOf(row.ID, row.Name, row.City, row.RaceDate, row.Timezone)
	if err != nil {
		return Station{}, err
	}
	st := Station{Event: ev}

	stats, err := q.RacepackStats(ctx, eventID)
	if err != nil {
		return Station{}, fmt.Errorf("racepack stats of event %d: %w", eventID, err)
	}
	st.Confirmed, st.Picked = stats.Confirmed, stats.Picked

	recent, err := q.RecentRacepackIssues(ctx, eventID)
	if err != nil {
		return Station{}, fmt.Errorf("recent racepack issues of event %d: %w", eventID, err)
	}
	for _, r := range recent {
		st.Recent = append(st.Recent, Recent{
			RegistrationID: r.RegistrationID,
			FullName:       r.FullName,
			Bib:            bibOf(r.BibNumber, r.DisplayDigits),
			ProxyName:      r.ProxyName,
			StaffName:      r.StaffName,
			OccurredAt:     r.OccurredAt,
		})
	}

	query = strings.TrimSpace(query)
	if query == "" {
		return st, nil
	}
	params := store.SearchRacepackParams{EventID: eventID, Q: query, Digits: digitsOf(query)}
	if n, err := strconv.Atoi(strings.TrimLeft(query, "#")); err == nil && n > 0 && n <= 1<<30 {
		params.Bib = int32(n)
	}
	rows, err := q.SearchRacepack(ctx, params)
	if err != nil {
		return Station{}, fmt.Errorf("search racepack of event %d: %w", eventID, err)
	}
	for _, r := range rows {
		e, err := entryOf(store.GetRacepackEntryRow(r))
		if err != nil {
			return Station{}, err
		}
		st.Results = append(st.Results, e)
	}
	return st, nil
}

// Issue 发放领物。同一 clientEventId 的重试返回 ALREADY；已领过的返回 ALREADY 并记一条流水；
// 报名未确认（付款未核验）或已取消时记一条 REJECTED 流水后返回 RACEPACK_NOT_PAID；
// 本地价参赛人首次领物没有核验证件时返回 RACEPACK_ID_REQUIRED。
func (s *Service) Issue(ctx context.Context, actor iam.Staff, registrationID int64, in IssueInput, meta httpx.Meta) (string, Entry, error) {
	if strings.TrimSpace(in.DeviceID) == "" {
		return "", Entry{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	}
	proxy := trimmedOrNil(in.ProxyName)
	now := s.now().UTC()
	var outcome string
	var rejected bool
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		reg, err := s.lockRegistration(ctx, q, actor, registrationID)
		if err != nil {
			return err
		}
		if done, err := replayed(ctx, q, in.ClientEventID, registrationID); err != nil || done {
			outcome = OutcomeAlready
			return err
		}
		logParams := store.InsertScanLogParams{
			ClientEventID:  pgUUID(in.ClientEventID),
			RegistrationID: registrationID,
			EventID:        reg.EventID,
			Action:         ActionIssue,
			StaffID:        actor.ID,
			DeviceID:       in.DeviceID,
			OccurredAt:     now,
			ProxyName:      proxy,
		}
		if reg.Status != "CONFIRMED" {
			reason := BlockNotPaid
			if reg.Status == "CANCELLED" {
				reason = BlockCancelled
			}
			logParams.Outcome, logParams.Reason = OutcomeRejected, &reason
			rejected = true
			return q.InsertScanLog(ctx, logParams)
		}

		fact, err := q.GetRacepackFactForUpdate(ctx, registrationID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock racepack fact %d: %w", registrationID, err)
		}
		if fact.Picked {
			outcome = OutcomeAlready
			logParams.Outcome = OutcomeAlready
			return q.InsertScanLog(ctx, logParams)
		}
		if reg.Audience == "LOCAL" && !fact.IDVerified && !in.IDVerified {
			return apperr.New(http.StatusConflict, apperr.CodeRacepackIDRequired)
		}

		staffID, deviceID := actor.ID, in.DeviceID
		newlyVerified := in.IDVerified && !fact.IDVerified
		if err := q.UpsertRacepackIssued(ctx, store.UpsertRacepackIssuedParams{
			RegistrationID: registrationID,
			Now:            now,
			StaffID:        &staffID,
			DeviceID:       &deviceID,
			ProxyName:      proxy,
			IDVerified:     in.IDVerified,
		}); err != nil {
			return fmt.Errorf("mark racepack %d issued: %w", registrationID, err)
		}
		if newlyVerified {
			if err := q.InsertScanLog(ctx, store.InsertScanLogParams{
				ClientEventID:  pgUUID(uuid.New()),
				RegistrationID: registrationID,
				EventID:        reg.EventID,
				Action:         ActionVerifyID,
				Outcome:        OutcomeApplied,
				StaffID:        actor.ID,
				DeviceID:       in.DeviceID,
				OccurredAt:     now,
			}); err != nil {
				return fmt.Errorf("log id verification of %d: %w", registrationID, err)
			}
		}
		outcome = OutcomeApplied
		logParams.Outcome = OutcomeApplied
		if err := q.InsertScanLog(ctx, logParams); err != nil {
			return fmt.Errorf("log racepack issue of %d: %w", registrationID, err)
		}
		return audit.Record(ctx, tx, staffEntry(actor, "racepack.issue", registrationID, reg.EventID,
			"发放领物", map[string]any{"proxyName": proxy, "idVerified": in.IDVerified}, meta))
	})
	if err != nil {
		return "", Entry{}, err
	}
	if rejected {
		return "", Entry{}, apperr.New(http.StatusConflict, apperr.CodeRacepackNotPaid)
	}
	entry, err := s.entry(ctx, registrationID)
	return outcome, entry, err
}

// Undo 撤销一次发放（发错人、重复发放），必须写原因。未领取时返回 RACEPACK_NOT_PICKED。
func (s *Service) Undo(ctx context.Context, actor iam.Staff, registrationID int64, in UndoInput, meta httpx.Meta) (string, Entry, error) {
	reason := strings.TrimSpace(in.Reason)
	if reason == "" || strings.TrimSpace(in.DeviceID) == "" {
		return "", Entry{}, apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	}
	outcome := OutcomeApplied
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		reg, err := s.lockRegistration(ctx, q, actor, registrationID)
		if err != nil {
			return err
		}
		if done, err := replayed(ctx, q, in.ClientEventID, registrationID); err != nil || done {
			outcome = OutcomeAlready
			return err
		}
		fact, err := q.GetRacepackFactForUpdate(ctx, registrationID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !fact.Picked) {
			return apperr.New(http.StatusConflict, apperr.CodeRacepackNotPicked)
		}
		if err != nil {
			return fmt.Errorf("lock racepack fact %d: %w", registrationID, err)
		}
		deviceID := in.DeviceID
		if err := q.MarkRacepackUndone(ctx, store.MarkRacepackUndoneParams{DeviceID: &deviceID, RegistrationID: registrationID}); err != nil {
			return fmt.Errorf("undo racepack %d: %w", registrationID, err)
		}
		if err := q.InsertScanLog(ctx, store.InsertScanLogParams{
			ClientEventID:  pgUUID(in.ClientEventID),
			RegistrationID: registrationID,
			EventID:        reg.EventID,
			Action:         ActionUndo,
			Outcome:        OutcomeApplied,
			Reason:         &reason,
			StaffID:        actor.ID,
			DeviceID:       in.DeviceID,
			OccurredAt:     s.now().UTC(),
		}); err != nil {
			return fmt.Errorf("log racepack undo of %d: %w", registrationID, err)
		}
		return audit.Record(ctx, tx, staffEntry(actor, "racepack.undo", registrationID, reg.EventID,
			"撤销领物："+reason, map[string]any{"reason": reason}, meta))
	})
	if err != nil {
		return "", Entry{}, err
	}
	entry, err := s.entry(ctx, registrationID)
	return outcome, entry, err
}

func (s *Service) lockRegistration(ctx context.Context, q *store.Queries, actor iam.Staff, id int64) (store.LockRegistrationForRacepackRow, error) {
	reg, err := q.LockRegistrationForRacepack(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return reg, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return reg, fmt.Errorf("lock registration %d: %w", id, err)
	}
	if err := s.checkScope(ctx, q, actor, reg.EventID); err != nil {
		return reg, err
	}
	return reg, nil
}

// replayed：同一 clientEventId 已经处理过（网络重试）时返回 true；属于别的报名则是客户端错误。
func replayed(ctx context.Context, q *store.Queries, clientEventID [16]byte, registrationID int64) (bool, error) {
	prev, err := q.GetScanLogByClientID(ctx, pgUUID(clientEventID))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("find scan log by client id: %w", err)
	}
	if prev.RegistrationID != registrationID {
		return true, apperr.New(http.StatusConflict, apperr.CodeIdempotencyKeyReused)
	}
	return true, nil
}

func (s *Service) entry(ctx context.Context, registrationID int64) (Entry, error) {
	row, err := store.New(s.pool).GetRacepackEntry(ctx, registrationID)
	if err != nil {
		return Entry{}, fmt.Errorf("get racepack entry %d: %w", registrationID, err)
	}
	return entryOf(row)
}

func entryOf(r store.GetRacepackEntryRow) (Entry, error) {
	var cat i18n.Text
	if err := json.Unmarshal(r.CategoryName, &cat); err != nil {
		return Entry{}, fmt.Errorf("decode category name of registration %d: %w", r.ID, err)
	}
	e := Entry{
		RegistrationID: r.ID,
		RegNo:          r.RegNo,
		OrderNo:        r.OrderNo,
		Status:         r.Status,
		OrderStatus:    r.OrderStatus,
		FullName:       r.FullName,
		TshirtSize:     r.TshirtSize,
		PhoneLast4:     last4(r.PhoneE164),
		Audience:       r.Audience,
		CategoryCode:   r.CategoryCode,
		CategoryName:   cat,
		Bib:            bibOf(r.BibNumber, r.DisplayDigits),
		Picked:         r.Picked,
		PickedAt:       r.PickedAt,
		PickedByName:   r.PickedByName,
		ProxyName:      r.ProxyName,
		IDVerified:     r.IDVerified,
	}
	switch r.Status {
	case "PENDING":
		v := BlockNotPaid
		e.BlockReason = &v
	case "CANCELLED":
		v := BlockCancelled
		e.BlockReason = &v
	}
	return e, nil
}

func eventOf(id int64, name []byte, city string, raceDate time.Time, tz string) (Event, error) {
	var t i18n.Text
	if err := json.Unmarshal(name, &t); err != nil {
		return Event{}, fmt.Errorf("decode name of event %d: %w", id, err)
	}
	return Event{ID: id, Name: t, City: city, RaceDate: raceDate, Timezone: tz}, nil
}

func staffEntry(actor iam.Staff, action string, registrationID, eventID int64, summary string, after any, meta httpx.Meta) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: "registration",
		EntityID:   registrationID,
		EventID:    &eventID,
		Summary:    summary,
		After:      after,
		Meta:       meta,
	}
}

// bibOf 按号段的展示位数补零；号段没配置时原样显示。
func bibOf(n *int32, digits *int16) *string {
	if n == nil {
		return nil
	}
	w := 0
	if digits != nil {
		w = int(*digits)
	}
	v := fmt.Sprintf("%0*d", w, *n)
	return &v
}

func last4(phone *string) *string {
	if phone == nil || len(*phone) < 4 {
		return nil
	}
	v := (*phone)[len(*phone)-4:]
	return &v
}

func digitsOf(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func trimmedOrNil(s *string) *string {
	if s == nil {
		return nil
	}
	v := strings.TrimSpace(*s)
	if v == "" {
		return nil
	}
	return &v
}

func pgUUID(b [16]byte) pgtype.UUID {
	return pgtype.UUID{Bytes: b, Valid: true}
}
