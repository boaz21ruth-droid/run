// Package volunteer 是赛事志愿者（v8 设计稿 09）：主办方建岗位与席位，跑者选能参加的日期与 1–3 个岗位申请，
// 运营把申请分配到岗位（占一个席位）、转候补或拒绝。满员的岗位照样可以选，申请先进待处理，由运营决定候补。
package volunteer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner"
	"werun/api/internal/volunteer/store"
)

// 申请状态。
const (
	StatusPending   = "PENDING"
	StatusAssigned  = "ASSIGNED"
	StatusWaitlist  = "WAITLIST"
	StatusRejected  = "REJECTED"
	StatusWithdrawn = "WITHDRAWN"

	maxRoles      = 3
	maxDates      = 14
	maxNameLen    = 80
	maxNoteLen    = 500
	maxReviewLen  = 200
	maxRoleText   = 120
	maxRoleSeats  = 10000
	maxRolesEvent = 30
)

var (
	langs       = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}
	tshirtSizes = []string{"XS", "S", "M", "L", "XL", "XXL"}
)

func init() {
	apperr.RegisterConstraint("volunteer_applications_active_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeVolunteerApplied)
	})
}

// Service 是志愿者模块的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建服务。
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service {
	return &Service{pool: pool, now: now}
}

// Settings 是赛事的志愿者设置。
type Settings struct {
	Open  bool
	Dates []time.Time // 日期，UTC 零点
	Note  i18n.Text   // nil 表示没有说明
}

// Role 是一个志愿者岗位。Candidates 是选了它、还在待处理或候补的申请数（只在后台列表填充）。
type Role struct {
	ID            int64
	Name          i18n.Text
	Schedule      i18n.Text
	Capacity      int32
	AssignedCount int32
	SortOrder     int16
	Active        bool
	Candidates    int32
}

// Remaining 是剩余席位，下限 0。
func (r Role) Remaining() int32 {
	return max(r.Capacity-r.AssignedCount, 0)
}

// Application 是一份志愿者申请。
type Application struct {
	ID               int64
	Status           string
	FullName         string
	Phone            string
	TelegramUsername *string
	FullAvailability bool
	Dates            []time.Time
	RoleIDs          []int64
	TShirtSize       *string
	Note             *string
	MediaConsent     bool
	AssignedRoleID   *int64
	AssignedRoleName i18n.Text // 只在跑者视图填充
	ReviewNote       *string
	CreatedAt        time.Time
}

// RunnerView 是跑者打开志愿者页看到的内容。
type RunnerView struct {
	Settings    Settings
	Roles       []Role // 只含启用中的岗位
	Application *Application
}

// Board 是后台的志愿者页：设置、全部岗位与申请。
type Board struct {
	Settings     Settings
	Roles        []Role
	Applications []Application
}

// ApplyInput 是跑者提交的申请。
type ApplyInput struct {
	FullName         string
	Phone            string
	FullAvailability bool
	Dates            []time.Time
	RoleIDs          []int64
	TShirtSize       string
	Note             string
	MediaConsent     bool
	ConductAccepted  bool
}

// RoleInput 是新建或修改岗位的输入。
type RoleInput struct {
	Name      i18n.Text
	Schedule  i18n.Text
	Capacity  int32
	SortOrder int16
	Active    bool
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

// GetForRunner 返回已发布赛事的志愿者设置、启用中的岗位与本人最近一份申请。
func (s *Service) GetForRunner(ctx context.Context, u runner.User, slug string) (RunnerView, error) {
	q := store.New(s.pool)
	ev, err := q.GetVolunteerEventBySlug(ctx, strings.TrimSpace(slug))
	if errors.Is(err, pgx.ErrNoRows) {
		return RunnerView{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return RunnerView{}, fmt.Errorf("load event %q: %w", slug, err)
	}
	settings, err := settingsOf(ev.VolunteerOpen, ev.VolunteerDates, ev.VolunteerNote)
	if err != nil {
		return RunnerView{}, err
	}
	roles, err := loadRoles(ctx, q, ev.ID, nil)
	if err != nil {
		return RunnerView{}, err
	}
	out := RunnerView{Settings: settings, Roles: slices.DeleteFunc(roles, func(r Role) bool { return !r.Active })}
	row, err := q.GetMyVolunteerApplication(ctx, store.GetMyVolunteerApplicationParams{EventID: ev.ID, UserID: u.ID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return RunnerView{}, fmt.Errorf("load volunteer application: %w", err)
	default:
		app := applicationOf(volunteerApplicationOf(row))
		if len(row.AssignedRoleName) > 0 {
			if app.AssignedRoleName, err = decodeText(row.AssignedRoleName); err != nil {
				return RunnerView{}, err
			}
		}
		out.Application = &app
	}
	return out, nil
}

// Apply 提交申请：日期须在赛事列出的日期里，岗位须是本赛事启用中的岗位（满员也可以选）。
func (s *Service) Apply(ctx context.Context, u runner.User, slug string, in ApplyInput, meta httpx.Meta) (Application, error) {
	in = normalizeApply(in)
	var out Application
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		ev, err := q.GetVolunteerEventBySlug(ctx, strings.TrimSpace(slug))
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("load event %q: %w", slug, err)
		}
		locked, err := q.LockVolunteerEvent(ctx, ev.ID)
		if err != nil {
			return fmt.Errorf("lock event %d: %w", ev.ID, err)
		}
		if !locked.VolunteerOpen {
			return apperr.New(http.StatusConflict, apperr.CodeVolunteerClosed)
		}
		roles, err := q.ListVolunteerRoles(ctx, ev.ID)
		if err != nil {
			return fmt.Errorf("list volunteer roles: %w", err)
		}
		if err := validateApply(in, locked.VolunteerDates, roles); err != nil {
			return err
		}
		dates := in.Dates
		if in.FullAvailability {
			dates = []time.Time{}
		}
		id, err := q.InsertVolunteerApplication(ctx, store.InsertVolunteerApplicationParams{
			EventID:          ev.ID,
			UserID:           u.ID,
			FullName:         in.FullName,
			PhoneE164:        in.Phone,
			FullAvailability: in.FullAvailability,
			Dates:            dates,
			RoleIds:          in.RoleIDs,
			TshirtSize:       optText(in.TShirtSize),
			Note:             optText(in.Note),
			MediaConsent:     in.MediaConsent,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		row, err := q.GetMyVolunteerApplication(ctx, store.GetMyVolunteerApplicationParams{EventID: ev.ID, UserID: u.ID})
		if err != nil {
			return fmt.Errorf("reload volunteer application: %w", err)
		}
		out = applicationOf(volunteerApplicationOf(row))
		eventID := ev.ID
		actorID := u.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "USER",
			ActorID:    &actorID,
			Action:     "volunteer.apply",
			EntityType: "volunteer_application",
			EntityID:   id,
			EventID:    &eventID,
			Summary:    fmt.Sprintf("申请志愿者（%d 个岗位）", len(in.RoleIDs)),
			After:      map[string]any{"roleIds": in.RoleIDs, "fullAvailability": in.FullAvailability},
			Meta:       meta,
		})
	})
	if err != nil {
		return Application{}, err
	}
	return out, nil
}

// Withdraw 撤回本人进行中的申请；已分配的释放岗位席位。
func (s *Service) Withdraw(ctx context.Context, u runner.User, slug string, meta httpx.Meta) (Application, error) {
	var out Application
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		ev, err := q.GetVolunteerEventBySlug(ctx, strings.TrimSpace(slug))
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("load event %q: %w", slug, err)
		}
		app, err := q.LockMyActiveVolunteerApplication(ctx, store.LockMyActiveVolunteerApplicationParams{EventID: ev.ID, UserID: u.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock volunteer application: %w", err)
		}
		if err := releaseSeat(ctx, q, app); err != nil {
			return err
		}
		if err := q.WithdrawVolunteerApplication(ctx, app.ID); err != nil {
			return fmt.Errorf("withdraw volunteer application %d: %w", app.ID, err)
		}
		row, err := q.GetMyVolunteerApplication(ctx, store.GetMyVolunteerApplicationParams{EventID: ev.ID, UserID: u.ID})
		if err != nil {
			return fmt.Errorf("reload volunteer application: %w", err)
		}
		out = applicationOf(volunteerApplicationOf(row))
		eventID := ev.ID
		actorID := u.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "volunteer.withdraw", EntityType: "volunteer_application",
			EntityID: app.ID, EventID: &eventID, Summary: "撤回志愿者申请",
			Before: map[string]any{"status": app.Status}, After: map[string]any{"status": StatusWithdrawn}, Meta: meta,
		})
	})
	if err != nil {
		return Application{}, err
	}
	return out, nil
}

// Board 返回后台志愿者页。
func (s *Service) Board(ctx context.Context, eventID int64) (Board, error) {
	return loadBoard(ctx, store.New(s.pool), eventID)
}

// UpdateSettings 开关志愿者报名、设置日期与说明。
func (s *Service) UpdateSettings(ctx context.Context, actor iam.Staff, eventID int64, in Settings) (Board, error) {
	dates := uniqueDates(in.Dates)
	verr := validationError()
	failed := false
	if len(dates) > maxDates {
		verr = verr.WithField("dates", "field.invalid", nil)
		failed = true
	}
	if in.Open && len(dates) == 0 {
		verr = verr.WithField("dates", "field.required", nil)
		failed = true
	}
	var note []byte
	if in.Note != nil {
		trimmed := trimText(in.Note)
		for _, l := range langs {
			if utf8.RuneCountInString(trimmed[l]) > maxRoleText {
				verr = verr.WithField("note."+string(l), "field.too_long", map[string]any{"max": maxRoleText})
				failed = true
			}
		}
		if !emptyText(trimmed) {
			encoded, err := json.Marshal(trimmed)
			if err != nil {
				return Board{}, fmt.Errorf("encode volunteer note: %w", err)
			}
			note = encoded
		}
	}
	if failed {
		return Board{}, verr
	}
	var out Board
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		n, err := q.UpdateVolunteerSettings(ctx, store.UpdateVolunteerSettingsParams{
			VolunteerOpen: in.Open, VolunteerDates: dates, VolunteerNote: note, ID: eventID,
		})
		if err != nil {
			return fmt.Errorf("update volunteer settings of event %d: %w", eventID, err)
		}
		if n == 0 {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if out, err = loadBoard(ctx, q, eventID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "volunteer.settings_update", "event", eventID, eventID,
			fmt.Sprintf("修改志愿者设置（开放：%t，%d 天）", in.Open, len(dates)),
			nil, map[string]any{"open": in.Open, "dates": len(dates)}))
	})
	if err != nil {
		return Board{}, err
	}
	return out, nil
}

// CreateRole 新建岗位。
func (s *Service) CreateRole(ctx context.Context, actor iam.Staff, eventID int64, in RoleInput) (Board, error) {
	name, schedule, err := validateRole(in, 0)
	if err != nil {
		return Board{}, err
	}
	var out Board
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if _, err := q.GetVolunteerEvent(ctx, eventID); errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		} else if err != nil {
			return fmt.Errorf("load event %d: %w", eventID, err)
		}
		existing, err := q.ListVolunteerRoles(ctx, eventID)
		if err != nil {
			return fmt.Errorf("list volunteer roles: %w", err)
		}
		if len(existing) >= maxRolesEvent {
			return validationError().WithField("name", "field.invalid", nil)
		}
		id, err := q.InsertVolunteerRole(ctx, store.InsertVolunteerRoleParams{
			EventID: eventID, Name: name, Schedule: schedule, Capacity: in.Capacity, SortOrder: in.SortOrder,
		})
		if err != nil {
			return fmt.Errorf("insert volunteer role: %w", err)
		}
		if out, err = loadBoard(ctx, q, eventID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "volunteer.role_create", "volunteer_role", id, eventID,
			fmt.Sprintf("新建志愿者岗位 %s（%d 席）", in.Name.In(i18n.ZH), in.Capacity),
			nil, map[string]any{"capacity": in.Capacity}))
	})
	if err != nil {
		return Board{}, err
	}
	return out, nil
}

// UpdateRole 修改岗位；席位不能少于已分配人数。停用的岗位跑者看不到，已分配的人不受影响。
func (s *Service) UpdateRole(ctx context.Context, actor iam.Staff, roleID int64, in RoleInput) (Board, error) {
	var out Board
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		role, err := q.LockVolunteerRole(ctx, roleID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock volunteer role %d: %w", roleID, err)
		}
		name, schedule, err := validateRole(in, role.AssignedCount)
		if err != nil {
			return err
		}
		if err := q.UpdateVolunteerRole(ctx, store.UpdateVolunteerRoleParams{
			Name: name, Schedule: schedule, Capacity: in.Capacity, SortOrder: in.SortOrder, Active: in.Active, ID: roleID,
		}); err != nil {
			return fmt.Errorf("update volunteer role %d: %w", roleID, err)
		}
		if out, err = loadBoard(ctx, q, role.EventID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "volunteer.role_update", "volunteer_role", roleID, role.EventID,
			fmt.Sprintf("修改志愿者岗位 %s（%d 席，启用：%t）", in.Name.In(i18n.ZH), in.Capacity, in.Active),
			map[string]any{"capacity": role.Capacity, "active": role.Active},
			map[string]any{"capacity": in.Capacity, "active": in.Active}))
	})
	if err != nil {
		return Board{}, err
	}
	return out, nil
}

// Assign 把申请分配到岗位（不限于申请人选的岗位），占一个席位；已在别的岗位时先释放原岗位。
func (s *Service) Assign(ctx context.Context, actor iam.Staff, appID, roleID int64) (Board, error) {
	return s.review(ctx, actor, appID, func(q *store.Queries, app store.VolunteerApplication) (string, string, error) {
		if app.AssignedRoleID != nil && *app.AssignedRoleID == roleID {
			return "", "", apperr.New(http.StatusConflict, apperr.CodeVolunteerStateConflict)
		}
		role, err := q.LockVolunteerRole(ctx, roleID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && role.EventID != app.EventID) {
			return "", "", validationError().WithField("roleId", "field.invalid", nil)
		}
		if err != nil {
			return "", "", fmt.Errorf("lock volunteer role %d: %w", roleID, err)
		}
		if err := releaseSeat(ctx, q, app); err != nil {
			return "", "", err
		}
		n, err := q.TakeVolunteerSeat(ctx, roleID)
		if err != nil {
			return "", "", fmt.Errorf("take seat in role %d: %w", roleID, err)
		}
		if n != 1 {
			return "", "", apperr.New(http.StatusConflict, apperr.CodeVolunteerRoleFull)
		}
		return StatusAssigned, fmt.Sprintf("分配志愿者 %s 到岗位 %d", app.FullName, roleID), q.SetVolunteerApplicationStatus(ctx, reviewParams(app.ID, StatusAssigned, &roleID, nil, actor, s.now()))
	})
}

// Waitlist 转候补；已分配的释放席位。
func (s *Service) Waitlist(ctx context.Context, actor iam.Staff, appID int64) (Board, error) {
	return s.review(ctx, actor, appID, func(q *store.Queries, app store.VolunteerApplication) (string, string, error) {
		if app.Status == StatusWaitlist {
			return "", "", apperr.New(http.StatusConflict, apperr.CodeVolunteerStateConflict)
		}
		if err := releaseSeat(ctx, q, app); err != nil {
			return "", "", err
		}
		return StatusWaitlist, fmt.Sprintf("志愿者 %s 转候补", app.FullName), q.SetVolunteerApplicationStatus(ctx, reviewParams(app.ID, StatusWaitlist, nil, nil, actor, s.now()))
	})
}

// Reject 拒绝；note 会展示给申请人。已分配的释放席位。
func (s *Service) Reject(ctx context.Context, actor iam.Staff, appID int64, note string) (Board, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxReviewLen {
		return Board{}, validationError().WithField("note", "field.too_long", map[string]any{"max": maxReviewLen})
	}
	return s.review(ctx, actor, appID, func(q *store.Queries, app store.VolunteerApplication) (string, string, error) {
		if err := releaseSeat(ctx, q, app); err != nil {
			return "", "", err
		}
		return StatusRejected, fmt.Sprintf("拒绝志愿者 %s", app.FullName), q.SetVolunteerApplicationStatus(ctx, reviewParams(app.ID, StatusRejected, nil, optText(note), actor, s.now()))
	})
}

type reviewFunc func(q *store.Queries, app store.VolunteerApplication) (status, summary string, err error)

// review 锁住申请，要求仍在进行中（待处理 / 已分配 / 候补），执行 apply 并写审计，返回最新的后台页。
func (s *Service) review(ctx context.Context, actor iam.Staff, appID int64, apply reviewFunc) (Board, error) {
	var out Board
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		app, err := q.LockVolunteerApplication(ctx, appID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock volunteer application %d: %w", appID, err)
		}
		if app.Status == StatusRejected || app.Status == StatusWithdrawn {
			return apperr.New(http.StatusConflict, apperr.CodeVolunteerStateConflict)
		}
		status, summary, err := apply(q, app)
		if err != nil {
			return err
		}
		if out, err = loadBoard(ctx, q, app.EventID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "volunteer.review", "volunteer_application", app.ID, app.EventID, summary,
			map[string]any{"status": app.Status, "roleId": app.AssignedRoleID},
			map[string]any{"status": status}))
	})
	if err != nil {
		return Board{}, err
	}
	return out, nil
}

func reviewParams(id int64, status string, roleID *int64, note *string, actor iam.Staff, now time.Time) store.SetVolunteerApplicationStatusParams {
	actorID := actor.ID
	at := now.UTC()
	return store.SetVolunteerApplicationStatusParams{
		Status: status, AssignedRoleID: roleID, ReviewNote: note, ReviewedBy: &actorID, ReviewedAt: &at, ID: id,
	}
}

// releaseSeat 在申请已分配时把原岗位的席位还回去。
func releaseSeat(ctx context.Context, q *store.Queries, app store.VolunteerApplication) error {
	if app.Status != StatusAssigned || app.AssignedRoleID == nil {
		return nil
	}
	if _, err := q.LockVolunteerRole(ctx, *app.AssignedRoleID); err != nil {
		return fmt.Errorf("lock volunteer role %d: %w", *app.AssignedRoleID, err)
	}
	n, err := q.ReleaseVolunteerSeat(ctx, *app.AssignedRoleID)
	if err != nil {
		return fmt.Errorf("release seat in role %d: %w", *app.AssignedRoleID, err)
	}
	if n != 1 {
		return fmt.Errorf("volunteer role %d has no assigned seat to release", *app.AssignedRoleID)
	}
	return nil
}

func loadBoard(ctx context.Context, q *store.Queries, eventID int64) (Board, error) {
	ev, err := q.GetVolunteerEvent(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Board{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return Board{}, fmt.Errorf("load event %d: %w", eventID, err)
	}
	settings, err := settingsOf(ev.VolunteerOpen, ev.VolunteerDates, ev.VolunteerNote)
	if err != nil {
		return Board{}, err
	}
	rows, err := q.ListVolunteerApplications(ctx, eventID)
	if err != nil {
		return Board{}, fmt.Errorf("list volunteer applications: %w", err)
	}
	apps := make([]Application, 0, len(rows))
	candidates := map[int64]int32{}
	for _, r := range rows {
		app := applicationOf(store.VolunteerApplication{
			ID: r.ID, EventID: r.EventID, UserID: r.UserID, FullName: r.FullName, PhoneE164: r.PhoneE164,
			FullAvailability: r.FullAvailability, Dates: r.Dates, RoleIds: r.RoleIds, TshirtSize: r.TshirtSize, Note: r.Note,
			MediaConsent: r.MediaConsent, Status: r.Status, AssignedRoleID: r.AssignedRoleID, ReviewNote: r.ReviewNote,
			ReviewedBy: r.ReviewedBy, ReviewedAt: r.ReviewedAt, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		})
		app.TelegramUsername = r.TelegramUsername
		apps = append(apps, app)
		if r.Status == StatusPending || r.Status == StatusWaitlist {
			for _, id := range r.RoleIds {
				candidates[id]++
			}
		}
	}
	roles, err := loadRoles(ctx, q, eventID, candidates)
	if err != nil {
		return Board{}, err
	}
	return Board{Settings: settings, Roles: roles, Applications: apps}, nil
}

func loadRoles(ctx context.Context, q *store.Queries, eventID int64, candidates map[int64]int32) ([]Role, error) {
	rows, err := q.ListVolunteerRoles(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list volunteer roles: %w", err)
	}
	out := make([]Role, 0, len(rows))
	for _, r := range rows {
		name, err := decodeText(r.Name)
		if err != nil {
			return nil, err
		}
		var schedule i18n.Text
		if len(r.Schedule) > 0 {
			if schedule, err = decodeText(r.Schedule); err != nil {
				return nil, err
			}
		}
		out = append(out, Role{
			ID: r.ID, Name: name, Schedule: schedule, Capacity: r.Capacity, AssignedCount: r.AssignedCount,
			SortOrder: r.SortOrder, Active: r.Active, Candidates: candidates[r.ID],
		})
	}
	return out, nil
}

func settingsOf(open bool, dates []time.Time, note []byte) (Settings, error) {
	out := Settings{Open: open, Dates: dates}
	if out.Dates == nil {
		out.Dates = []time.Time{}
	}
	if len(note) > 0 {
		text, err := decodeText(note)
		if err != nil {
			return Settings{}, err
		}
		out.Note = text
	}
	return out, nil
}

func applicationOf(r store.VolunteerApplication) Application {
	dates := r.Dates
	if dates == nil {
		dates = []time.Time{}
	}
	return Application{
		ID: r.ID, Status: r.Status, FullName: r.FullName, Phone: r.PhoneE164, FullAvailability: r.FullAvailability,
		Dates: dates, RoleIDs: r.RoleIds, TShirtSize: r.TshirtSize, Note: r.Note, MediaConsent: r.MediaConsent,
		AssignedRoleID: r.AssignedRoleID, ReviewNote: r.ReviewNote, CreatedAt: r.CreatedAt,
	}
}

func volunteerApplicationOf(r store.GetMyVolunteerApplicationRow) store.VolunteerApplication {
	return store.VolunteerApplication{
		ID: r.ID, EventID: r.EventID, UserID: r.UserID, FullName: r.FullName, PhoneE164: r.PhoneE164,
		FullAvailability: r.FullAvailability, Dates: r.Dates, RoleIds: r.RoleIds, TshirtSize: r.TshirtSize, Note: r.Note,
		MediaConsent: r.MediaConsent, Status: r.Status, AssignedRoleID: r.AssignedRoleID, ReviewNote: r.ReviewNote,
		ReviewedBy: r.ReviewedBy, ReviewedAt: r.ReviewedAt, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func normalizeApply(in ApplyInput) ApplyInput {
	in.FullName = strings.TrimSpace(in.FullName)
	in.Phone = strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(strings.TrimSpace(in.Phone))
	in.TShirtSize = strings.ToUpper(strings.TrimSpace(in.TShirtSize))
	in.Note = strings.TrimSpace(in.Note)
	in.Dates = uniqueDates(in.Dates)
	ids := slices.Clone(in.RoleIDs)
	slices.Sort(ids)
	in.RoleIDs = slices.Compact(ids)
	return in
}

func validateApply(in ApplyInput, offered []time.Time, roles []store.VolunteerRole) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}
	switch {
	case in.FullName == "":
		add("fullName", "field.required", nil)
	case utf8.RuneCountInString(in.FullName) > maxNameLen:
		add("fullName", "field.too_long", map[string]any{"max": maxNameLen})
	}
	switch {
	case in.Phone == "":
		add("phone", "field.required", nil)
	case !runner.ValidE164(in.Phone):
		add("phone", "field.invalid", nil)
	}
	if !in.FullAvailability {
		switch {
		case len(in.Dates) == 0:
			add("dates", "field.required", nil)
		case slices.ContainsFunc(in.Dates, func(d time.Time) bool {
			return !slices.ContainsFunc(offered, func(o time.Time) bool { return o.Equal(d) })
		}):
			add("dates", "field.invalid", nil)
		}
	}
	active := map[int64]bool{}
	for _, r := range roles {
		active[r.ID] = r.Active
	}
	switch {
	case len(in.RoleIDs) == 0:
		add("roleIds", "field.required", nil)
	case len(in.RoleIDs) > maxRoles:
		add("roleIds", "field.volunteer_roles_max", map[string]any{"max": maxRoles})
	case slices.ContainsFunc(in.RoleIDs, func(id int64) bool { return !active[id] }):
		add("roleIds", "field.invalid", nil)
	}
	if in.TShirtSize != "" && !slices.Contains(tshirtSizes, in.TShirtSize) {
		add("tshirtSize", "field.invalid", nil)
	}
	if utf8.RuneCountInString(in.Note) > maxNoteLen {
		add("note", "field.too_long", map[string]any{"max": maxNoteLen})
	}
	if !in.ConductAccepted {
		add("conductAccepted", "field.required", nil)
	}
	if failed {
		return verr
	}
	return nil
}

// validateRole 校验岗位：名称三语必填，席位 0–10000 且不少于已分配人数；返回编码后的名称与说明。
func validateRole(in RoleInput, assigned int32) ([]byte, []byte, error) {
	verr := validationError()
	failed := false
	name := trimText(in.Name)
	schedule := trimText(in.Schedule)
	for _, l := range langs {
		switch {
		case name[l] == "":
			verr = verr.WithField("name."+string(l), "field.required", nil)
			failed = true
		case utf8.RuneCountInString(name[l]) > maxRoleText:
			verr = verr.WithField("name."+string(l), "field.too_long", map[string]any{"max": maxRoleText})
			failed = true
		}
		if utf8.RuneCountInString(schedule[l]) > maxRoleText {
			verr = verr.WithField("schedule."+string(l), "field.too_long", map[string]any{"max": maxRoleText})
			failed = true
		}
	}
	switch {
	case in.Capacity < 0 || in.Capacity > maxRoleSeats:
		verr = verr.WithField("capacity", "field.invalid", nil)
		failed = true
	case in.Capacity < assigned:
		verr = verr.WithField("capacity", "field.quota_below_taken", map[string]any{"min": assigned})
		failed = true
	}
	if failed {
		return nil, nil, verr
	}
	encodedName, err := json.Marshal(name)
	if err != nil {
		return nil, nil, fmt.Errorf("encode role name: %w", err)
	}
	var encodedSchedule []byte
	if !emptyText(schedule) {
		if encodedSchedule, err = json.Marshal(schedule); err != nil {
			return nil, nil, fmt.Errorf("encode role schedule: %w", err)
		}
	}
	return encodedName, encodedSchedule, nil
}

func uniqueDates(in []time.Time) []time.Time {
	out := make([]time.Time, 0, len(in))
	for _, d := range in {
		day := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
		if !slices.ContainsFunc(out, func(o time.Time) bool { return o.Equal(day) }) {
			out = append(out, day)
		}
	}
	slices.SortFunc(out, func(a, b time.Time) int { return a.Compare(b) })
	return out
}

func trimText(t i18n.Text) i18n.Text {
	out := make(i18n.Text, len(langs))
	for _, l := range langs {
		if v := strings.TrimSpace(t[l]); v != "" {
			out[l] = v
		}
	}
	return out
}

func emptyText(t i18n.Text) bool {
	for _, v := range t {
		if v != "" {
			return false
		}
	}
	return true
}

func decodeText(raw []byte) (i18n.Text, error) {
	var t i18n.Text
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("decode localized text: %w", err)
	}
	return t, nil
}

func optText(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func staffEntry(ctx context.Context, actor iam.Staff, action, entityType string, entityID, eventID int64, summary string, before, after any) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: entityType,
		EntityID:   entityID,
		EventID:    &eventID,
		Summary:    summary,
		Before:     before,
		After:      after,
		Meta:       httpx.MetaOf(ctx),
	}
}
