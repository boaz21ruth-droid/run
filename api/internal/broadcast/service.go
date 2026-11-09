// Package broadcast 是主办方群发通知（v8 设计稿 10「发通知」）：按人群发一条消息，
// 每位收件人一条 Telegram 推送（走 notify 的发送队列），同时显示在跑者的「我的赛事」。
package broadcast

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
	"werun/api/internal/broadcast/store"
	"werun/api/internal/iam"
	"werun/api/internal/notify"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner"
)

// 人群。
const (
	AudiencePaid       = "PAID"
	AudiencePending    = "PENDING"
	AudienceElite      = "ELITE"
	AudienceVolunteers = "VOLUNTEERS"

	maxBodyLen = 500
	// MaxRecipients 是一次群发的收件人上限：每人一条推送任务在同一事务里入队，过大的批次会拖长事务。
	MaxRecipients = 5000
	// duplicateWindow 内同一人群同一正文不能再发（防连点）。
	duplicateWindow = 10 * time.Minute
)

// Audiences 是全部人群，顺序即后台展示顺序。
var Audiences = []string{AudiencePaid, AudiencePending, AudienceElite, AudienceVolunteers}

// Service 是群发通知的业务入口。
type Service struct {
	pool     *pgxpool.Pool
	notifier *notify.Service
	now      func() time.Time
}

// NewService 创建服务。
func NewService(pool *pgxpool.Pool, notifier *notify.Service, now func() time.Time) *Service {
	return &Service{pool: pool, notifier: notifier, now: now}
}

// AudienceCount 是一个人群当前的人数。
type AudienceCount struct {
	Audience string
	Count    int32
}

// Item 是一次已发的群发。
type Item struct {
	ID                                     int64
	Audience, Body, SenderName             string
	RecipientCount, SentCount, FailedCount int32
	CreatedAt                              time.Time
}

// Board 是后台「发通知」页。
type Board struct {
	Audiences []AudienceCount
	Items     []Item
}

// Notice 是跑者看到的一条通知。
type Notice struct {
	ID        int64
	EventSlug string
	EventName i18n.Text
	Body      string
	CreatedAt time.Time
}

// Board 返回各人群人数与已发记录。
func (s *Service) Board(ctx context.Context, eventID int64) (Board, error) {
	q := store.New(s.pool)
	if _, err := q.GetBroadcastEvent(ctx, eventID); errors.Is(err, pgx.ErrNoRows) {
		return Board{}, apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	} else if err != nil {
		return Board{}, fmt.Errorf("load event %d: %w", eventID, err)
	}
	return loadBoard(ctx, q, eventID)
}

// Send 给一个人群发通知：收件人此刻算定并记下，每人入队一条推送，写审计 broadcast.send。
func (s *Service) Send(ctx context.Context, actor iam.Staff, eventID int64, audience, body string) (Board, error) {
	body = strings.TrimSpace(body)
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	failed := false
	if !slices.Contains(Audiences, audience) {
		verr = verr.WithField("audience", "field.invalid", nil)
		failed = true
	}
	switch {
	case body == "":
		verr = verr.WithField("body", "field.required", nil)
		failed = true
	case utf8.RuneCountInString(body) > maxBodyLen:
		verr = verr.WithField("body", "field.too_long", map[string]any{"max": maxBodyLen})
		failed = true
	}
	if failed {
		return Board{}, verr
	}
	var out Board
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		ev, err := q.GetBroadcastEvent(ctx, eventID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
		}
		if err != nil {
			return fmt.Errorf("load event %d: %w", eventID, err)
		}
		// 同一赛事的群发串行，防重复判断不被并发绕过
		if err := q.LockBroadcastEvent(ctx, eventID); err != nil {
			return fmt.Errorf("lock event %d: %w", eventID, err)
		}
		dups, err := q.CountRecentDuplicate(ctx, store.CountRecentDuplicateParams{
			EventID: eventID, Audience: audience, Body: body, Since: s.now().Add(-duplicateWindow),
		})
		if err != nil {
			return fmt.Errorf("count recent broadcasts: %w", err)
		}
		if dups > 0 {
			return apperr.New(http.StatusConflict, apperr.CodeBroadcastDuplicate)
		}
		users, err := audienceUsers(ctx, q, eventID, audience)
		if err != nil {
			return err
		}
		if len(users) == 0 {
			return apperr.New(http.StatusUnprocessableEntity, apperr.CodeBroadcastNoRecipients)
		}
		if len(users) > MaxRecipients {
			return verr.WithField("audience", "field.invalid", nil)
		}
		row, err := q.InsertBroadcast(ctx, store.InsertBroadcastParams{
			EventID: eventID, Audience: audience, Body: body, RecipientCount: int32(len(users)), CreatedBy: actor.ID,
		})
		if err != nil {
			return fmt.Errorf("insert broadcast: %w", err)
		}
		if err := q.InsertBroadcastRecipients(ctx, store.InsertBroadcastRecipientsParams{BroadcastID: row.ID, UserIds: users}); err != nil {
			return fmt.Errorf("insert broadcast recipients: %w", err)
		}
		var name i18n.Text
		if err := json.Unmarshal(ev.Name, &name); err != nil {
			return fmt.Errorf("decode event %d name: %w", eventID, err)
		}
		for _, uid := range users {
			if err := s.notifier.EnqueueBroadcast(ctx, tx, notify.Broadcast{BroadcastID: row.ID, UserID: uid, EventName: name, Body: body}); err != nil {
				return err
			}
		}
		if out, err = loadBoard(ctx, q, eventID); err != nil {
			return err
		}
		actorID := actor.ID
		role := string(actor.Role)
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "STAFF", ActorID: &actorID, ActorRole: &role, Action: "broadcast.send", EntityType: "event_broadcast",
			EntityID: row.ID, EventID: &eventID, Summary: fmt.Sprintf("给 %s 发通知（%d 人）", audience, len(users)),
			After: map[string]any{"audience": audience, "recipients": len(users), "bodyLength": utf8.RuneCountInString(body)},
			Meta:  httpx.MetaOf(ctx),
		})
	})
	if err != nil {
		return Board{}, err
	}
	return out, nil
}

// Notices 返回发给跑者的最近通知。
func (s *Service) Notices(ctx context.Context, u runner.User) ([]Notice, error) {
	rows, err := store.New(s.pool).ListMyNotices(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("list notices of user %d: %w", u.ID, err)
	}
	out := make([]Notice, 0, len(rows))
	for _, r := range rows {
		var name i18n.Text
		if err := json.Unmarshal(r.EventName, &name); err != nil {
			return nil, fmt.Errorf("decode event name: %w", err)
		}
		out = append(out, Notice{ID: r.ID, EventSlug: r.EventSlug, EventName: name, Body: r.Body, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

func audienceUsers(ctx context.Context, q *store.Queries, eventID int64, audience string) ([]int64, error) {
	var ids []int64
	var err error
	switch audience {
	case AudiencePaid:
		ids, err = q.AudiencePaid(ctx, eventID)
	case AudiencePending:
		ids, err = q.AudiencePending(ctx, eventID)
	case AudienceElite:
		ids, err = q.AudienceElite(ctx, eventID)
	case AudienceVolunteers:
		ids, err = q.AudienceVolunteers(ctx, eventID)
	default:
		return nil, fmt.Errorf("unknown audience %q", audience)
	}
	if err != nil {
		return nil, fmt.Errorf("list %s audience of event %d: %w", audience, eventID, err)
	}
	slices.Sort(ids)
	return ids, nil
}

func loadBoard(ctx context.Context, q *store.Queries, eventID int64) (Board, error) {
	counts := make([]AudienceCount, 0, len(Audiences))
	for _, a := range Audiences {
		ids, err := audienceUsers(ctx, q, eventID, a)
		if err != nil {
			return Board{}, err
		}
		counts = append(counts, AudienceCount{Audience: a, Count: int32(len(ids))})
	}
	rows, err := q.ListBroadcasts(ctx, eventID)
	if err != nil {
		return Board{}, fmt.Errorf("list broadcasts of event %d: %w", eventID, err)
	}
	items := make([]Item, 0, len(rows))
	for _, r := range rows {
		items = append(items, Item{
			ID: r.ID, Audience: r.Audience, Body: r.Body, SenderName: r.SenderName, RecipientCount: r.RecipientCount,
			SentCount: r.SentCount, FailedCount: r.FailedCount, CreatedAt: r.CreatedAt,
		})
	}
	return Board{Audiences: counts, Items: items}, nil
}
