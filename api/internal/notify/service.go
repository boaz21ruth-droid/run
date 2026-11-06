package notify

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"werun/api/internal/notify/store"
	"werun/api/internal/platform/i18n"
)

// Service 负责在调用方事务里登记推送并入队发送任务。
type Service struct {
	inserter   JobInserter
	cat        *i18n.Catalog
	appBaseURL string
}

// NewService 创建推送服务；appBaseURL 为小程序地址前缀（WERUN_APP_BASE_URL）。
func NewService(inserter JobInserter, cat *i18n.Catalog, appBaseURL string) *Service {
	return &Service{inserter: inserter, cat: cat, appBaseURL: strings.TrimRight(appBaseURL, "/")}
}

// Enqueue 在 tx 内写 notification_logs 并 InsertTx 一个 notify_send 任务。
// 跑者没有 telegram_user_id 时什么都不做；同一 dedupe_key 已登记时返回 nil 且不入队。
// 只读 users、只写 notification_logs 与 river_job，不锁也不改订单、凭证行（不打乱调用方的加锁顺序）。
func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, n Notification) error {
	orderNo, _ := n.Params["orderNo"].(string)
	if orderNo == "" {
		return fmt.Errorf("notify: %s for order %d: params.orderNo is required", n.Template, n.OrderID)
	}

	q := store.New(tx)
	recipient, err := q.GetNotifyRecipient(ctx, n.UserID)
	if err != nil {
		return fmt.Errorf("notify: load recipient user %d: %w", n.UserID, err)
	}
	if recipient.TelegramUserID == nil {
		return nil
	}
	chatID := *recipient.TelegramUserID
	lang, ok := i18n.Parse(recipient.Locale)
	if !ok {
		lang = i18n.Default
	}

	dedupeKey := n.DedupeKey
	if dedupeKey == "" {
		var proofID int64
		if n.ProofID != nil {
			proofID = *n.ProofID
		}
		dedupeKey = fmt.Sprintf("%s:%d:%d", n.Template, n.OrderID, proofID)
	}

	orderID := n.OrderID
	logID, err := q.InsertNotificationLog(ctx, store.InsertNotificationLogParams{
		Recipient: strconv.FormatInt(chatID, 10),
		Template:  string(n.Template),
		Locale:    string(lang),
		EntityID:  &orderID,
		DedupeKey: dedupeKey,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // ON CONFLICT DO NOTHING：同键已登记
	}
	if err != nil {
		return fmt.Errorf("notify: insert notification log %s: %w", dedupeKey, err)
	}

	args := SendArgs{
		LogID:  logID,
		ChatID: chatID,
		Text:   render(s.cat, lang, n.Template, n.Params),
		Button: &Button{
			Text: s.cat.T(lang, "notify.open_order", nil),
			URL:  s.appBaseURL + "/orders/" + url.PathEscape(orderNo),
		},
	}
	if _, err := s.inserter.InsertTx(ctx, tx, args, &river.InsertOpts{MaxAttempts: SendMaxAttempts}); err != nil {
		return fmt.Errorf("notify: enqueue send job for log %d: %w", logID, err)
	}
	return nil
}

// TemplateEventBroadcast 是主办方群发通知的模板：赛事名 + 主办方原文。
const TemplateEventBroadcast Template = "event_broadcast"

// Broadcast 是一条群发通知发给一位跑者。
type Broadcast struct {
	BroadcastID int64
	UserID      int64
	EventName   i18n.Text
	Body        string // 主办方原文，不翻译
}

// EnqueueBroadcast 在 tx 内登记一条群发推送并入队（同一群发同一跑者只登记一次）；跑者没有 Telegram 时什么都不做。
// 按钮打开「我的赛事」，通知也显示在那里。
func (s *Service) EnqueueBroadcast(ctx context.Context, tx pgx.Tx, b Broadcast) error {
	q := store.New(tx)
	recipient, err := q.GetNotifyRecipient(ctx, b.UserID)
	if err != nil {
		return fmt.Errorf("notify: load recipient user %d: %w", b.UserID, err)
	}
	if recipient.TelegramUserID == nil {
		return nil
	}
	chatID := *recipient.TelegramUserID
	lang, ok := i18n.Parse(recipient.Locale)
	if !ok {
		lang = i18n.Default
	}
	broadcastID := b.BroadcastID
	logID, err := q.InsertBroadcastLog(ctx, store.InsertBroadcastLogParams{
		Recipient: strconv.FormatInt(chatID, 10),
		Locale:    string(lang),
		EntityID:  &broadcastID,
		DedupeKey: fmt.Sprintf("%s:%d:%d", TemplateEventBroadcast, b.BroadcastID, b.UserID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("notify: insert broadcast log %d/%d: %w", b.BroadcastID, b.UserID, err)
	}
	args := SendArgs{
		LogID:  logID,
		ChatID: chatID,
		Text:   render(s.cat, lang, TemplateEventBroadcast, map[string]any{"eventName": b.EventName, "body": b.Body}),
		Button: &Button{Text: s.cat.T(lang, "notify.open_my_events", nil), URL: s.appBaseURL + "/orders"},
	}
	if _, err := s.inserter.InsertTx(ctx, tx, args, &river.InsertOpts{MaxAttempts: SendMaxAttempts}); err != nil {
		return fmt.Errorf("notify: enqueue broadcast job for log %d: %w", logID, err)
	}
	return nil
}
