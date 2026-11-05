// Package community 是跑团页（v8 设计稿 07）：官方免费活动与跑团发起的跑友活动混排，
// 跑者发布活动（签署免责声明，按规则先审核或直接发布）、参加或候补，「今天谁在跑」签到。
// 平台不碰钱、不组织现场，只提供发布与报名记录。
package community

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/community/store"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/runner"
)

// 活动状态与报名状态。
const (
	StatusReviewing = "REVIEWING"
	StatusPublished = "PUBLISHED"
	StatusRejected  = "REJECTED"
	StatusClosed    = "CLOSED"

	JoinJoined   = "JOINED"
	JoinWaitlist = "WAITLIST"
	JoinLeft     = "LEFT"
	JoinNone     = "NONE"

	KindOfficial = "OFFICIAL"
	KindClub     = "CLUB"

	DefaultCity = "Phnom Penh"

	// checkinTTL 是「今天谁在跑」签到的有效时长。
	checkinTTL = 8 * time.Hour
	// feedGrace 是活动开始后仍留在跑团页的时长。
	feedGrace = 2 * time.Hour
	// maxOpenPerAuthor 是一人同时在审核中或即将开始的活动上限。
	maxOpenPerAuthor = 3
)

var (
	tags          = []string{"MORNING", "NIGHT", "LONG", "TRAIL", "TRAINING", "FAMILY", "CYCLING", "OTHER"}
	rejectCodes   = []string{"R01", "R02", "R03", "R04", "R05"}
	telegramName  = regexp.MustCompile(`^[A-Za-z0-9_]{5,32}$`).MatchString
	platformZone  = mustZone("Asia/Phnom_Penh")
	defaultFeeKey = "免费"
)

func mustZone(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

// Service 是跑团页的业务入口。
type Service struct {
	pool    *pgxpool.Pool
	runners *runner.Service
	now     func() time.Time
}

// NewService 创建服务。
func NewService(pool *pgxpool.Pool, runners *runner.Service, now func() time.Time) *Service {
	return &Service{pool: pool, runners: runners, now: now}
}

// FeedItem 是跑团页的一张卡片。
type FeedItem struct {
	Kind           string // KindOfficial | KindClub
	ID             int64
	EventSlug      *string
	Title          string
	StartsAt       time.Time
	City           string
	Location       string
	HostName       string
	Tag            *string
	DistanceText   *string
	Capacity       int32
	JoinedCount    int32
	WaitlistCount  int32
	FeeNote        *string
	CoverFileID    *int64
	JoinerInitials []string
}

// Checkin 是「今天谁在跑」里的一个人。
type Checkin struct {
	Name, Initials string
}

// Feed 是跑团页。
type Feed struct {
	Items    []FeedItem
	Checkins []Checkin
	Cities   []string
}

// Activity 是一个跑团活动。
type Activity struct {
	ID                int64
	AuthorUserID      int64
	Title             string
	Tag               string
	StartsAt          time.Time
	City              string
	Location          string
	MeetPoint         string
	DistanceText      *string
	Capacity          int32
	JoinedCount       int32
	WaitlistCount     int32
	FeeNote           string
	HostName          *string
	AuthorName        string
	Body              string
	ContactVisibility string
	ContactTelegram   *string
	ContactPhone      *string
	Status            string
	RejectCode        *string
	ReviewRequired    bool
	Frozen            bool
	FreezeReason      *string
	CreatedAt         time.Time
	JoinerInitials    []string
}

// Contact 是发起人联系方式。
type Contact struct {
	Telegram, Phone *string
}

// View 是跑者看到的活动与自己的状态。
type View struct {
	Activity Activity
	MyStatus string // JoinNone | JoinJoined | JoinWaitlist
	IsAuthor bool
	Contact  *Contact
}

// CreateInput 是发布活动的输入。
type CreateInput struct {
	Title, Tag        string
	StartsAt          time.Time
	City, Location    string
	MeetPoint         string
	DistanceText      string
	Capacity          int32
	FeeNote           string
	HostName          string
	ContactTelegram   string
	ContactPhone      string
	ContactVisibility string
	Body              string
	Consent           runner.ConsentAcceptance
}

// CheckinState 是本人签到状态与当前在跑的人。
type CheckinState struct {
	CheckedIn bool
	Checkins  []Checkin
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

// Feed 返回跑团页：kind 为 KindOfficial / KindClub 时只看一类，city 非空时只看该城市。
func (s *Service) Feed(ctx context.Context, kind, city string) (Feed, error) {
	q := store.New(s.pool)
	now := s.now()
	city = strings.TrimSpace(city)
	var items []FeedItem
	cities := map[string]bool{}
	if kind != KindClub {
		today := now.In(platformZone)
		rows, err := q.ListFeedOfficialEvents(ctx, time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC))
		if err != nil {
			return Feed{}, fmt.Errorf("list official free events: %w", err)
		}
		for _, r := range rows {
			var name i18n.Text
			if err := json.Unmarshal(r.Name, &name); err != nil {
				return Feed{}, fmt.Errorf("decode event %d name: %w", r.ID, err)
			}
			cities[r.City] = true
			if city != "" && !strings.EqualFold(r.City, city) {
				continue
			}
			location := r.City
			if r.Venue != nil && *r.Venue != "" {
				location = *r.Venue
			}
			slug := r.Slug
			items = append(items, FeedItem{
				Kind: KindOfficial, ID: r.ID, EventSlug: &slug, Title: name.In(httpx.LangOf(ctx)), StartsAt: r.StartsAt,
				City: r.City, Location: location, Capacity: r.Capacity, JoinedCount: r.Joined, CoverFileID: r.CoverFileID,
				JoinerInitials: []string{},
			})
		}
	}
	if kind != KindOfficial {
		rows, err := q.ListFeedActivities(ctx, now.Add(-feedGrace))
		if err != nil {
			return Feed{}, fmt.Errorf("list community activities: %w", err)
		}
		ids := make([]int64, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, r.ID)
		}
		initials, err := joinerInitials(ctx, q, ids)
		if err != nil {
			return Feed{}, err
		}
		for _, r := range rows {
			cities[r.City] = true
			if city != "" && !strings.EqualFold(r.City, city) {
				continue
			}
			tag := r.Tag
			fee := r.FeeNote
			items = append(items, FeedItem{
				Kind: KindClub, ID: r.ID, Title: r.Title, StartsAt: r.StartsAt, City: r.City, Location: r.Location,
				HostName: hostOf(r.HostName, r.AuthorName), Tag: &tag, DistanceText: r.DistanceText, Capacity: r.Capacity,
				JoinedCount: r.JoinedCount, WaitlistCount: r.WaitlistCount, FeeNote: &fee, JoinerInitials: initials[r.ID],
			})
		}
	}
	slices.SortStableFunc(items, func(a, b FeedItem) int { return a.StartsAt.Compare(b.StartsAt) })
	checkins, err := recentCheckins(ctx, q, now)
	if err != nil {
		return Feed{}, err
	}
	list := make([]string, 0, len(cities))
	for c := range cities {
		list = append(list, c)
	}
	slices.Sort(list)
	if items == nil {
		items = []FeedItem{}
	}
	return Feed{Items: items, Checkins: checkins, Cities: list}, nil
}

// GetPublic 返回已发布、未冻结的活动（不含联系方式）。
func (s *Service) GetPublic(ctx context.Context, id int64) (Activity, error) {
	q := store.New(s.pool)
	a, err := loadActivity(ctx, q, id)
	if err != nil {
		return Activity{}, err
	}
	if a.Status != StatusPublished || a.Frozen {
		return Activity{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return a, nil
}

// ViewFor 返回跑者看到的活动、本人状态与可见的联系方式；看到联系方式时记一条 contact_view_logs。
// 发起人可以看自己审核中、被拒或冻结的活动。
func (s *Service) ViewFor(ctx context.Context, u runner.User, id int64, meta httpx.Meta) (View, error) {
	q := store.New(s.pool)
	a, err := loadActivity(ctx, q, id)
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, q, u, a, meta)
}

func (s *Service) view(ctx context.Context, q *store.Queries, u runner.User, a Activity, meta httpx.Meta) (View, error) {
	isAuthor := a.AuthorUserID == u.ID
	if !isAuthor && (a.Status != StatusPublished || a.Frozen) {
		return View{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	status, err := myStatus(ctx, q, a.ID, u.ID)
	if err != nil {
		return View{}, err
	}
	v := View{Activity: a, MyStatus: status, IsAuthor: isAuthor}
	if isAuthor || a.ContactVisibility == "PUBLIC" || status == JoinJoined {
		v.Contact = &Contact{Telegram: a.ContactTelegram, Phone: a.ContactPhone}
		if !isAuthor {
			if err := logContactViews(ctx, q, a, u.ID, status == JoinJoined, meta); err != nil {
				return View{}, err
			}
		}
	}
	return v, nil
}

// Create 发布活动：同一事务里签署跑友活动免责声明；按 system_settings 的审核开关决定先审核还是直接发布。
func (s *Service) Create(ctx context.Context, u runner.User, in CreateInput, meta httpx.Meta) (Activity, error) {
	in = normalizeCreate(in)
	if err := validateCreate(in, s.now()); err != nil {
		return Activity{}, err
	}
	var out Activity
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		mine, err := q.ListMyActivities(ctx, u.ID)
		if err != nil {
			return fmt.Errorf("list my activities: %w", err)
		}
		open := 0
		for _, m := range mine {
			a := m.CommunityActivity
			if a.Status == StatusReviewing || (a.Status == StatusPublished && a.StartsAt.After(s.now())) {
				open++
			}
		}
		if open >= maxOpenPerAuthor {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityTooMany).WithParams(map[string]any{"max": maxOpenPerAuthor})
		}
		signatureID, err := s.runners.SignCommunityConsent(ctx, tx, u, in.Consent, meta)
		if err != nil {
			return err
		}
		review, err := q.ReviewRequiredDefault(ctx)
		if err != nil {
			return fmt.Errorf("load community review setting: %w", err)
		}
		status := StatusPublished
		if review {
			status = StatusReviewing
		}
		id, err := q.InsertActivity(ctx, store.InsertActivityParams{
			AuthorUserID: u.ID, ReviewRequired: review, SignatureID: signatureID, Title: in.Title, Tag: in.Tag,
			StartsAt: in.StartsAt.UTC(), Location: in.Location, MeetPoint: in.MeetPoint, DistanceText: optText(in.DistanceText),
			Capacity: in.Capacity, FeeNote: in.FeeNote, ContactTelegram: optText(in.ContactTelegram),
			ContactPhone: optText(in.ContactPhone), ContactVisibility: in.ContactVisibility, Body: in.Body, Status: status,
			HostName: optText(in.HostName), City: in.City,
		})
		if err != nil {
			return fmt.Errorf("insert community activity: %w", err)
		}
		if out, err = loadActivity(ctx, q, id); err != nil {
			return err
		}
		actorID := u.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "community.create", EntityType: "community_activity", EntityID: id,
			Summary: fmt.Sprintf("发布跑团活动「%s」（%s）", in.Title, status),
			After:   map[string]any{"status": status, "capacity": in.Capacity, "startsAt": in.StartsAt.UTC()}, Meta: meta,
		})
	})
	if err != nil {
		return Activity{}, err
	}
	return out, nil
}

// Mine 返回本人发布的活动。
func (s *Service) Mine(ctx context.Context, u runner.User) ([]Activity, error) {
	q := store.New(s.pool)
	rows, err := q.ListMyActivities(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("list my activities: %w", err)
	}
	out := make([]Activity, 0, len(rows))
	for _, r := range rows {
		out = append(out, activityOf(r.CommunityActivity, r.AuthorName, nil))
	}
	return out, nil
}

// Join 参加；满员时进候补。发起人不用报名自己的活动。
func (s *Service) Join(ctx context.Context, u runner.User, id int64, meta httpx.Meta) (View, error) {
	return s.changeJoin(ctx, u, id, meta, func(q *store.Queries, a store.CommunityActivity, current string, now time.Time) (string, error) {
		if a.AuthorUserID == u.ID || current == JoinJoined || current == JoinWaitlist {
			return "", apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		status := JoinJoined
		if a.JoinedCount >= a.Capacity {
			status = JoinWaitlist
		}
		err := q.UpsertJoin(ctx, store.UpsertJoinParams{ActivityID: a.ID, UserID: u.ID, Status: status, JoinedAt: now})
		return status, err
	})
}

// Leave 退出或取消候补；退出空出的名额按候补先后补上。
func (s *Service) Leave(ctx context.Context, u runner.User, id int64, meta httpx.Meta) (View, error) {
	return s.changeJoin(ctx, u, id, meta, func(q *store.Queries, a store.CommunityActivity, current string, now time.Time) (string, error) {
		if current != JoinJoined && current != JoinWaitlist {
			return "", apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		if err := q.LeaveJoin(ctx, store.LeaveJoinParams{LeftAt: &now, ActivityID: a.ID, UserID: u.ID}); err != nil {
			return "", err
		}
		if current == JoinJoined {
			next, err := q.FirstWaitlisted(ctx, a.ID)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
			case err != nil:
				return "", err
			default:
				if err := q.PromoteJoin(ctx, store.PromoteJoinParams{ActivityID: a.ID, UserID: next}); err != nil {
					return "", err
				}
			}
		}
		return JoinLeft, nil
	})
}

type joinFunc func(q *store.Queries, a store.CommunityActivity, current string, now time.Time) (string, error)

// changeJoin 锁住活动行，要求已发布、未冻结、未开始，执行 apply 后按报名表重算人数。
func (s *Service) changeJoin(ctx context.Context, u runner.User, id int64, meta httpx.Meta, apply joinFunc) (View, error) {
	var out View
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		a, err := q.LockActivity(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock activity %d: %w", id, err)
		}
		now := s.now().UTC()
		if a.Status != StatusPublished || a.Frozen || !a.StartsAt.After(now) {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityClosed)
		}
		current, err := myStatus(ctx, q, a.ID, u.ID)
		if err != nil {
			return err
		}
		next, err := apply(q, a, current, now)
		if err != nil {
			return apperr.FromPG(err)
		}
		if err := recount(ctx, tx, a.ID); err != nil {
			return err
		}
		loaded, err := loadActivity(ctx, q, a.ID)
		if err != nil {
			return err
		}
		if out, err = s.view(ctx, q, u, loaded, meta); err != nil {
			return err
		}
		actorID := u.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "community.join_change", EntityType: "community_activity", EntityID: a.ID,
			Summary: fmt.Sprintf("跑团活动报名 %s → %s", current, next),
			Before:  map[string]any{"status": current}, After: map[string]any{"status": next}, Meta: meta,
		})
	})
	if err != nil {
		return View{}, err
	}
	return out, nil
}

// recount 按报名表重算已参加与候补人数（行已被调用方锁住）。
func recount(ctx context.Context, tx pgx.Tx, activityID int64) error {
	var joined, waitlist int32
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE status = 'JOINED'), count(*) FILTER (WHERE status = 'WAITLIST')
		 FROM community_activity_joins WHERE activity_id = $1`, activityID).Scan(&joined, &waitlist); err != nil {
		return fmt.Errorf("count joins of activity %d: %w", activityID, err)
	}
	if err := store.New(tx).SetActivityCounts(ctx, store.SetActivityCountsParams{JoinedCount: joined, WaitlistCount: waitlist, ID: activityID}); err != nil {
		return apperr.FromPG(err)
	}
	return nil
}

// Close 发起人取消活动（审核中或已发布）。
func (s *Service) Close(ctx context.Context, u runner.User, id int64, meta httpx.Meta) (View, error) {
	var out View
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		a, err := q.LockActivity(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && a.AuthorUserID != u.ID) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock activity %d: %w", id, err)
		}
		if a.Status != StatusReviewing && a.Status != StatusPublished {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		if err := q.CloseActivity(ctx, id); err != nil {
			return fmt.Errorf("close activity %d: %w", id, err)
		}
		loaded, err := loadActivity(ctx, q, id)
		if err != nil {
			return err
		}
		if out, err = s.view(ctx, q, u, loaded, meta); err != nil {
			return err
		}
		actorID := u.ID
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "USER", ActorID: &actorID, Action: "community.close", EntityType: "community_activity", EntityID: id,
			Summary: "发起人取消跑团活动", Before: map[string]any{"status": a.Status}, After: map[string]any{"status": StatusClosed}, Meta: meta,
		})
	})
	if err != nil {
		return View{}, err
	}
	return out, nil
}

// CheckinState 返回本人今天是否签到与当前在跑的人。
func (s *Service) CheckinState(ctx context.Context, u runner.User) (CheckinState, error) {
	q := store.New(s.pool)
	now := s.now()
	checkins, err := recentCheckins(ctx, q, now)
	if err != nil {
		return CheckinState{}, err
	}
	var checkedIn bool
	err = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM community_checkins WHERE user_id = $1 AND checked_in_at > $2)`,
		u.ID, now.Add(-checkinTTL)).Scan(&checkedIn)
	if err != nil {
		return CheckinState{}, fmt.Errorf("load my checkin: %w", err)
	}
	return CheckinState{CheckedIn: checkedIn, Checkins: checkins}, nil
}

// Checkin 签到「今天我在跑」；Checkout 取消。
func (s *Service) Checkin(ctx context.Context, u runner.User, city string) (CheckinState, error) {
	city = strings.TrimSpace(city)
	if city == "" {
		city = DefaultCity
	}
	if utf8.RuneCountInString(city) > 40 {
		return CheckinState{}, validationError().WithField("city", "field.too_long", map[string]any{"max": 40})
	}
	if err := store.New(s.pool).UpsertCheckin(ctx, store.UpsertCheckinParams{UserID: u.ID, City: city, CheckedInAt: s.now().UTC()}); err != nil {
		return CheckinState{}, fmt.Errorf("checkin user %d: %w", u.ID, err)
	}
	return s.CheckinState(ctx, u)
}

// Checkout 取消今天的签到。
func (s *Service) Checkout(ctx context.Context, u runner.User) (CheckinState, error) {
	if err := store.New(s.pool).DeleteCheckin(ctx, u.ID); err != nil {
		return CheckinState{}, fmt.Errorf("checkout user %d: %w", u.ID, err)
	}
	return s.CheckinState(ctx, u)
}

// AdminList 返回审核列表；status 为空表示全部。
func (s *Service) AdminList(ctx context.Context, status string) ([]Activity, []*string, error) {
	var filter *string
	if status != "" {
		filter = &status
	}
	rows, err := store.New(s.pool).ListAdminActivities(ctx, filter)
	if err != nil {
		return nil, nil, fmt.Errorf("list community activities: %w", err)
	}
	out := make([]Activity, 0, len(rows))
	telegrams := make([]*string, 0, len(rows))
	for _, r := range rows {
		out = append(out, activityOf(r.CommunityActivity, r.AuthorName, nil))
		telegrams = append(telegrams, r.AuthorTelegram)
	}
	return out, telegrams, nil
}

// Approve 审核通过并发布。
func (s *Service) Approve(ctx context.Context, actor iam.Staff, id int64) (Activity, error) {
	return s.moderate(ctx, actor, id, "community.approve", func(q *store.Queries, a store.CommunityActivity, now time.Time) error {
		if a.Status != StatusReviewing {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		return q.ReviewActivity(ctx, store.ReviewActivityParams{Status: StatusPublished, ReviewedBy: &actor.ID, ReviewedAt: &now, ID: a.ID})
	})
}

// Reject 审核不通过，code 为 R01–R05。
func (s *Service) Reject(ctx context.Context, actor iam.Staff, id int64, code string) (Activity, error) {
	if !slices.Contains(rejectCodes, code) {
		return Activity{}, validationError().WithField("code", "field.invalid", nil)
	}
	return s.moderate(ctx, actor, id, "community.reject", func(q *store.Queries, a store.CommunityActivity, now time.Time) error {
		if a.Status != StatusReviewing {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		return q.ReviewActivity(ctx, store.ReviewActivityParams{Status: StatusRejected, RejectCode: &code, ReviewedBy: &actor.ID, ReviewedAt: &now, ID: a.ID})
	})
}

// Freeze 紧急冻结：跑者看不到、不能报名，解冻后恢复原状态。
func (s *Service) Freeze(ctx context.Context, actor iam.Staff, id int64, reason string) (Activity, error) {
	reason = strings.TrimSpace(reason)
	switch {
	case reason == "":
		return Activity{}, validationError().WithField("reason", "field.required", nil)
	case utf8.RuneCountInString(reason) > 200:
		return Activity{}, validationError().WithField("reason", "field.too_long", map[string]any{"max": 200})
	}
	return s.moderate(ctx, actor, id, "community.freeze", func(q *store.Queries, a store.CommunityActivity, now time.Time) error {
		if a.Frozen {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		return q.FreezeActivity(ctx, store.FreezeActivityParams{FreezeReason: &reason, FrozenBy: &actor.ID, FrozenAt: &now, ID: a.ID})
	})
}

// Unfreeze 解冻。
func (s *Service) Unfreeze(ctx context.Context, actor iam.Staff, id int64) (Activity, error) {
	return s.moderate(ctx, actor, id, "community.unfreeze", func(q *store.Queries, a store.CommunityActivity, _ time.Time) error {
		if !a.Frozen {
			return apperr.New(http.StatusConflict, apperr.CodeCommunityStateConflict)
		}
		return q.UnfreezeActivity(ctx, a.ID)
	})
}

func (s *Service) moderate(ctx context.Context, actor iam.Staff, id int64, action string, apply func(*store.Queries, store.CommunityActivity, time.Time) error) (Activity, error) {
	var out Activity
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		a, err := q.LockActivity(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock activity %d: %w", id, err)
		}
		if err := apply(q, a, s.now().UTC()); err != nil {
			return err
		}
		if out, err = loadActivity(ctx, q, id); err != nil {
			return err
		}
		actorID := actor.ID
		role := string(actor.Role)
		return audit.Record(ctx, tx, audit.Entry{
			ActorType: "STAFF", ActorID: &actorID, ActorRole: &role, Action: action, EntityType: "community_activity",
			EntityID: id, Summary: fmt.Sprintf("跑团活动「%s」%s", a.Title, action),
			Before: map[string]any{"status": a.Status, "frozen": a.Frozen}, After: map[string]any{"status": out.Status, "frozen": out.Frozen},
			Meta: httpx.MetaOf(ctx),
		})
	})
	if err != nil {
		return Activity{}, err
	}
	return out, nil
}

func loadActivity(ctx context.Context, q *store.Queries, id int64) (Activity, error) {
	row, err := q.GetActivity(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Activity{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return Activity{}, fmt.Errorf("load activity %d: %w", id, err)
	}
	initials, err := joinerInitials(ctx, q, []int64{id})
	if err != nil {
		return Activity{}, err
	}
	return activityOf(row.CommunityActivity, row.AuthorName, initials[id]), nil
}

func activityOf(a store.CommunityActivity, authorName *string, initials []string) Activity {
	if initials == nil {
		initials = []string{}
	}
	name := ""
	if authorName != nil {
		name = *authorName
	}
	return Activity{
		ID: a.ID, AuthorUserID: a.AuthorUserID, Title: a.Title, Tag: a.Tag, StartsAt: a.StartsAt, City: a.City,
		Location: a.Location, MeetPoint: a.MeetPoint, DistanceText: a.DistanceText, Capacity: a.Capacity,
		JoinedCount: a.JoinedCount, WaitlistCount: a.WaitlistCount, FeeNote: a.FeeNote, HostName: a.HostName,
		AuthorName: name, Body: a.Body, ContactVisibility: a.ContactVisibility, ContactTelegram: a.ContactTelegram,
		ContactPhone: a.ContactPhone, Status: a.Status, RejectCode: a.RejectCode, ReviewRequired: a.ReviewRequired,
		Frozen: a.Frozen, FreezeReason: a.FreezeReason, CreatedAt: a.CreatedAt, JoinerInitials: initials,
	}
}

func myStatus(ctx context.Context, q *store.Queries, activityID, userID int64) (string, error) {
	j, err := q.GetJoin(ctx, store.GetJoinParams{ActivityID: activityID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return JoinNone, nil
	}
	if err != nil {
		return "", fmt.Errorf("load join: %w", err)
	}
	if j.Status == JoinLeft {
		return JoinNone, nil
	}
	return j.Status, nil
}

func logContactViews(ctx context.Context, q *store.Queries, a Activity, viewer int64, joined bool, meta httpx.Meta) error {
	var ip *netip.Addr
	if addr, err := netip.ParseAddr(meta.IP); err == nil {
		ip = &addr
	}
	for typ, value := range map[string]*string{"TELEGRAM": a.ContactTelegram, "PHONE": a.ContactPhone} {
		if value == nil {
			continue
		}
		if err := q.InsertContactView(ctx, store.InsertContactViewParams{
			ActivityID: a.ID, ViewerUserID: viewer, ContactType: typ, ViewerJoined: joined, Ip: ip,
		}); err != nil {
			return fmt.Errorf("log contact view: %w", err)
		}
	}
	return nil
}

func joinerInitials(ctx context.Context, q *store.Queries, ids []int64) (map[int64][]string, error) {
	out := map[int64][]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.ListJoinerNames(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list joiner names: %w", err)
	}
	for _, r := range rows {
		name := ""
		if r.DisplayName != nil {
			name = *r.DisplayName
		}
		out[r.ActivityID] = append(out[r.ActivityID], initialsOf(name))
	}
	for _, id := range ids {
		if out[id] == nil {
			out[id] = []string{}
		}
	}
	return out, nil
}

func recentCheckins(ctx context.Context, q *store.Queries, now time.Time) ([]Checkin, error) {
	rows, err := q.ListRecentCheckins(ctx, now.Add(-checkinTTL))
	if err != nil {
		return nil, fmt.Errorf("list checkins: %w", err)
	}
	out := make([]Checkin, 0, len(rows))
	for _, r := range rows {
		name := ""
		if r.DisplayName != nil {
			name = *r.DisplayName
		}
		first := strings.Fields(name)
		short := "?"
		if len(first) > 0 {
			short = first[0]
		}
		out = append(out, Checkin{Name: short, Initials: initialsOf(name)})
	}
	return out, nil
}

// initialsOf 取显示名前两个词的首字母（大写），一个词时取前两个字符；空名为 "?"。
func initialsOf(name string) string {
	words := strings.Fields(name)
	var b strings.Builder
	switch {
	case len(words) == 0:
		return "?"
	case len(words) == 1:
		for i, r := range []rune(words[0]) {
			if i >= 2 {
				break
			}
			b.WriteRune(unicode.ToUpper(r))
		}
	default:
		for _, w := range words[:2] {
			r, _ := utf8.DecodeRuneInString(w)
			b.WriteRune(unicode.ToUpper(r))
		}
	}
	return b.String()
}

func hostOf(host, author *string) string {
	if host != nil && *host != "" {
		return *host
	}
	if author != nil {
		return *author
	}
	return ""
}

func normalizeCreate(in CreateInput) CreateInput {
	trim := strings.TrimSpace
	in.Title, in.Tag, in.City, in.Location, in.MeetPoint = trim(in.Title), strings.ToUpper(trim(in.Tag)), trim(in.City), trim(in.Location), trim(in.MeetPoint)
	in.DistanceText, in.FeeNote, in.HostName, in.Body = trim(in.DistanceText), trim(in.FeeNote), trim(in.HostName), trim(in.Body)
	in.ContactTelegram = strings.TrimPrefix(trim(in.ContactTelegram), "@")
	in.ContactPhone = strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(trim(in.ContactPhone))
	if in.City == "" {
		in.City = DefaultCity
	}
	if in.FeeNote == "" {
		in.FeeNote = defaultFeeKey
	}
	if in.ContactVisibility == "" {
		in.ContactVisibility = "JOINED"
	}
	return in
}

func validateCreate(in CreateInput, now time.Time) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}
	text := func(field, v string, max int, required bool) {
		switch {
		case v == "" && required:
			add(field, "field.required", nil)
		case utf8.RuneCountInString(v) > max:
			add(field, "field.too_long", map[string]any{"max": max})
		}
	}
	text("title", in.Title, 30, true)
	text("city", in.City, 40, true)
	text("location", in.Location, 80, true)
	text("meetPoint", in.MeetPoint, 120, true)
	text("distanceText", in.DistanceText, 40, false)
	text("feeNote", in.FeeNote, 40, false)
	text("hostName", in.HostName, 40, false)
	text("body", in.Body, 1000, true)
	if !slices.Contains(tags, in.Tag) {
		add("tag", "field.invalid", nil)
	}
	switch {
	case in.StartsAt.IsZero():
		add("startsAt", "field.required", nil)
	case !in.StartsAt.After(now.Add(time.Hour)):
		add("startsAt", "field.community_starts_soon", nil)
	case in.StartsAt.After(now.AddDate(0, 3, 0)):
		add("startsAt", "field.invalid", nil)
	}
	if in.Capacity < 1 || in.Capacity > 500 {
		add("capacity", "field.invalid", nil)
	}
	if in.ContactVisibility != "JOINED" && in.ContactVisibility != "PUBLIC" {
		add("contactVisibility", "field.invalid", nil)
	}
	switch {
	case in.ContactTelegram == "" && in.ContactPhone == "":
		add("contactTelegram", "field.community_contact_required", nil)
	case in.ContactTelegram != "" && !telegramName(in.ContactTelegram):
		add("contactTelegram", "field.invalid", nil)
	case in.ContactPhone != "" && !runner.ValidE164(in.ContactPhone):
		add("contactPhone", "field.invalid", nil)
	}
	if failed {
		return verr
	}
	return nil
}

func optText(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
