package event

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/event/store"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
)

func init() {
	apperr.RegisterConstraint("events_slug_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken).
			WithField("slug", apperr.CodeEventSlugTaken, nil)
	})
	apperr.RegisterConstraint("event_categories_event_id_code_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeEventCategoryCodeTaken)
	})
}

// Service 是赛事模块的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建赛事服务。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: time.Now}
}

// Create 新建草稿赛事及其组别，并写审计 event.create。
func (s *Service) Create(ctx context.Context, actor iam.Staff, in CreateInput) (Event, error) {
	if err := ValidateCreate(in); err != nil {
		return Event{}, err
	}
	name, err := json.Marshal(in.Name)
	if err != nil {
		return Event{}, fmt.Errorf("encode event name: %w", err)
	}

	var out Event
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		actorID := actor.ID
		row, err := q.InsertEvent(ctx, store.InsertEventParams{
			Slug:          in.Slug,
			EventType:     in.EventType,
			OrganizerType: in.OrganizerType,
			Name:          name,
			City:          in.City,
			RaceDate:      in.RaceDate,
			CreatedBy:     &actorID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		ev, err := eventFromRow(row)
		if err != nil {
			return err
		}

		for i, c := range in.Categories {
			catName, err := json.Marshal(c.Name)
			if err != nil {
				return fmt.Errorf("encode category name: %w", err)
			}
			crow, err := q.InsertCategory(ctx, store.InsertCategoryParams{
				EventID:   ev.ID,
				Code:      c.Code,
				Name:      catName,
				DistanceM: c.DistanceM,
				Capacity:  c.Capacity,
				StartAt:   c.StartAt,
				CutoffAt:  c.CutoffAt,
				SortOrder: int16(i),
			})
			if err != nil {
				return apperr.FromPG(err)
			}
			cat, err := categoryFromRow(crow)
			if err != nil {
				return err
			}
			ev.Categories = append(ev.Categories, cat)
		}

		out = ev
		return audit.Record(ctx, tx, staffAudit(ctx, actor, "event.create", ev,
			fmt.Sprintf("新建赛事 %s（%d 个组别）", ev.Slug, len(ev.Categories))))
	})
	if err != nil {
		return Event{}, err
	}
	return out, nil
}

// Publish 锁定赛事行，做发布前校验，置为已发布并公开展示，写审计 event.publish。
func (s *Service) Publish(ctx context.Context, actor iam.Staff, id int64) (Event, error) {
	var out Event
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetEventForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %d: %w", id, err)
		}
		ev, err := eventFromRow(row)
		if err != nil {
			return err
		}
		cats, err := loadCategories(ctx, q, []int64{ev.ID})
		if err != nil {
			return err
		}
		ev.Categories = cats[ev.ID]

		if err := ValidateForPublish(ev); err != nil {
			return err
		}

		now := s.now().UTC()
		actorID := actor.ID
		updated, err := q.PublishEvent(ctx, store.PublishEventParams{
			PublishedAt: &now,
			PublishedBy: &actorID,
			ID:          ev.ID,
		})
		if err != nil {
			return apperr.FromPG(err)
		}
		published, err := eventFromRow(updated)
		if err != nil {
			return err
		}
		published.Categories = ev.Categories

		out = published
		return audit.Record(ctx, tx, staffAudit(ctx, actor, "event.publish", published,
			fmt.Sprintf("发布赛事 %s", published.Slug)))
	})
	if err != nil {
		return Event{}, err
	}
	return out, nil
}

// GetAdmin 返回任意状态的赛事及其组别（后台用）；不存在返回 EVENT_NOT_FOUND。
func (s *Service) GetAdmin(ctx context.Context, id int64) (Event, error) {
	q := store.New(s.pool)
	row, err := q.GetEventByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return Event{}, fmt.Errorf("get event %d: %w", id, err)
	}
	events, err := withCategories(ctx, q, []store.Event{row})
	if err != nil {
		return Event{}, err
	}
	return events[0], nil
}

// UpdateRegistration 修改报名开关与报名时间。设为开放时锁定赛事行并做开放前校验
// （CheckRegistrationReady，统计用本包自己的查询，不依赖 pricing / payment 包），写审计 event.registration_update。
func (s *Service) UpdateRegistration(ctx context.Context, actor iam.Staff, id int64, in RegistrationInput) (Event, error) {
	if err := ValidateRegistration(in); err != nil {
		return Event{}, err
	}
	var out Event
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetEventForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock event %d: %w", id, err)
		}
		before, err := eventFromRow(row)
		if err != nil {
			return err
		}

		if in.Open {
			var noPrice []string
			var accounts int64
			if before.EventType == TypeRace {
				if noPrice, err = q.ListCategoryCodesWithoutPriceRule(ctx, before.ID); err != nil {
					return fmt.Errorf("list categories without price rule: %w", err)
				}
				if accounts, err = q.CountRegistrationPaymentAccounts(ctx, before.ID); err != nil {
					return fmt.Errorf("count payment accounts: %w", err)
				}
			}
			if err := CheckRegistrationReady(before, noPrice, accounts); err != nil {
				return err
			}
		}

		updatedRow, err := q.UpdateEventRegistration(ctx, store.UpdateEventRegistrationParams{
			RegistrationOpen:     in.Open,
			RegistrationOpensAt:  in.OpensAt,
			RegistrationClosesAt: in.ClosesAt,
			ID:                   before.ID,
		})
		if err != nil {
			return fmt.Errorf("update registration of event %d: %w", id, err)
		}
		updated, err := eventFromRow(updatedRow)
		if err != nil {
			return err
		}
		cats, err := loadCategories(ctx, q, []int64{updated.ID})
		if err != nil {
			return err
		}
		updated.Categories = cats[updated.ID]
		out = updated

		actorID := actor.ID
		role := string(actor.Role)
		eventID := updated.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType:  "STAFF",
			ActorID:    &actorID,
			ActorRole:  &role,
			Action:     "event.registration_update",
			EntityType: "event",
			EntityID:   updated.ID,
			EventID:    &eventID,
			Summary:    fmt.Sprintf("修改赛事 %s 报名设置（开放：%t）", updated.Slug, updated.RegistrationOpen),
			Before:     registrationSnapshot(before),
			After:      registrationSnapshot(updated),
			Meta:       httpx.MetaOf(ctx),
		})
	})
	if err != nil {
		return Event{}, err
	}
	return out, nil
}

func registrationSnapshot(e Event) map[string]any {
	return map[string]any{
		"open":     e.RegistrationOpen,
		"opensAt":  e.RegistrationOpensAt,
		"closesAt": e.RegistrationClosesAt,
	}
}

// ListAll 返回全部赛事（后台用），按比赛日期倒序。
func (s *Service) ListAll(ctx context.Context) ([]Event, error) {
	q := store.New(s.pool)
	rows, err := q.ListEvents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	return withCategories(ctx, q, rows)
}

// ListPublic 返回已发布且公开展示的赛事，按比赛日期升序。
func (s *Service) ListPublic(ctx context.Context) ([]Event, error) {
	q := store.New(s.pool)
	rows, err := q.ListPublicEvents(ctx)
	if err != nil {
		return nil, fmt.Errorf("list public events: %w", err)
	}
	return withCategories(ctx, q, rows)
}

// GetPublic 按 slug 取已发布且公开展示的赛事；不存在或未公开返回 EVENT_NOT_FOUND。
func (s *Service) GetPublic(ctx context.Context, slug string) (Event, error) {
	q := store.New(s.pool)
	row, err := q.GetPublicEventBySlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	if err != nil {
		return Event{}, fmt.Errorf("get public event %q: %w", slug, err)
	}
	events, err := withCategories(ctx, q, []store.Event{row})
	if err != nil {
		return Event{}, err
	}
	return events[0], nil
}

func withCategories(ctx context.Context, q *store.Queries, rows []store.Event) ([]Event, error) {
	events := make([]Event, 0, len(rows))
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ev, err := eventFromRow(r)
		if err != nil {
			return nil, err
		}
		events = append(events, ev)
		ids = append(ids, ev.ID)
	}
	cats, err := loadCategories(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range events {
		events[i].Categories = cats[events[i].ID]
	}
	return events, nil
}

func loadCategories(ctx context.Context, q *store.Queries, eventIDs []int64) (map[int64][]Category, error) {
	out := make(map[int64][]Category, len(eventIDs))
	if len(eventIDs) == 0 {
		return out, nil
	}
	rows, err := q.ListCategoriesByEventIDs(ctx, eventIDs)
	if err != nil {
		return nil, fmt.Errorf("list categories: %w", err)
	}
	for _, r := range rows {
		c, err := categoryFromRow(r)
		if err != nil {
			return nil, err
		}
		out[r.EventID] = append(out[r.EventID], c)
	}
	return out, nil
}

func eventFromRow(r store.Event) (Event, error) {
	var name i18n.Text
	if err := json.Unmarshal(r.Name, &name); err != nil {
		return Event{}, fmt.Errorf("decode name of event %d: %w", r.ID, err)
	}
	return Event{
		ID:                   r.ID,
		Slug:                 r.Slug,
		EventType:            r.EventType,
		OrganizerType:        r.OrganizerType,
		Name:                 name,
		City:                 r.City,
		RaceDate:             r.RaceDate,
		Timezone:             r.Timezone,
		Status:               r.Status,
		PublicVisible:        r.PublicVisible,
		PublishedAt:          r.PublishedAt,
		RegistrationOpen:     r.RegistrationOpen,
		RegistrationOpensAt:  r.RegistrationOpensAt,
		RegistrationClosesAt: r.RegistrationClosesAt,
	}, nil
}

func categoryFromRow(r store.EventCategory) (Category, error) {
	var name i18n.Text
	if err := json.Unmarshal(r.Name, &name); err != nil {
		return Category{}, fmt.Errorf("decode name of category %d: %w", r.ID, err)
	}
	return Category{
		ID:            r.ID,
		Code:          r.Code,
		Name:          name,
		DistanceM:     r.DistanceM,
		Capacity:      r.Capacity,
		StartAt:       r.StartAt,
		CutoffAt:      r.CutoffAt,
		MinAge:        r.MinAge,
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}, nil
}

func staffAudit(ctx context.Context, actor iam.Staff, action string, ev Event, summary string) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	eventID := ev.ID
	codes := make([]string, 0, len(ev.Categories))
	for _, c := range ev.Categories {
		codes = append(codes, c.Code)
	}
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: "event",
		EntityID:   ev.ID,
		EventID:    &eventID,
		Summary:    summary,
		After: map[string]any{
			"slug":          ev.Slug,
			"status":        ev.Status,
			"publicVisible": ev.PublicVisible,
			"categories":    codes,
		},
		Meta: httpx.MetaOf(ctx),
	}
}
