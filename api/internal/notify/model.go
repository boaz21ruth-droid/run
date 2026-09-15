// Package notify 负责推送：登记 notification_logs、按跑者语言渲染模板、入队并执行 Telegram 发送任务。
package notify

import (
	"context"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata" // 运行镜像不一定带时区库

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"werun/api/internal/platform/i18n"
)

// Template 是推送模板名；文案 key 为 "notify.<Template>"。
type Template string

const (
	TemplateProofApproved    Template = "proof_approved"
	TemplateProofRejected    Template = "proof_rejected"
	TemplateDeadlineReminder Template = "payment_deadline_reminder"
	TemplateOrderExpired     Template = "order_expired"
)

// notification_logs.status 的取值。
const (
	StatusPending = "PENDING"
	StatusSent    = "SENT"
	StatusFailed  = "FAILED"
)

// SendMaxAttempts 是 notify_send 任务的最大尝试次数（含第一次）。
const SendMaxAttempts = 5

// DefaultTimezone 是赛事时区为空或无效时使用的时区。
const DefaultTimezone = "Asia/Phnom_Penh"

// Notification 是一条待登记的推送。
type Notification struct {
	Template  Template
	UserID    int64
	OrderID   int64
	ProofID   *int64
	DedupeKey string         // 空串时用 "<template>:<orderId>:<proofId 或 0>"
	Params    map[string]any // 文案参数：orderNo（必填）、deadline、reason、eventName
}

// JobInserter 是 notify 需要的最小 River 能力；*river.Client[pgx.Tx] 实现了它。
type JobInserter interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// RejectReason 作为 Params 的值时，按收件人语言渲染为原因码文案，Note 非空时换行追加说明。
type RejectReason struct {
	Code string
	Note *string
}

// SendArgs 是 notify_send 任务参数。文本在入队时已按收件人语言渲染好。
type SendArgs struct {
	LogID  int64   `json:"log_id"`
	ChatID int64   `json:"chat_id"`
	Text   string  `json:"text"`
	Button *Button `json:"button,omitempty"`
}

// Kind 是 River 任务类型名。
func (SendArgs) Kind() string { return "notify_send" }

// FormatTime 把时间按时区格式化为 YYYY-MM-DD HH:mm；时区为空或无法加载时用 Asia/Phnom_Penh。
func FormatTime(t time.Time, timezone string) string {
	loc := defaultLocation()
	if timezone != "" {
		if l, err := time.LoadLocation(timezone); err == nil {
			loc = l
		}
	}
	return t.In(loc).Format("2006-01-02 15:04")
}

func defaultLocation() *time.Location {
	loc, err := time.LoadLocation(DefaultTimezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// render 用收件人语言渲染模板正文。
func render(cat *i18n.Catalog, lang i18n.Lang, tpl Template, params map[string]any) string {
	return cat.T(lang, "notify."+string(tpl), localizeParams(cat, lang, params))
}

func localizeParams(cat *i18n.Catalog, lang i18n.Lang, params map[string]any) map[string]any {
	if params == nil {
		return nil
	}
	out := make(map[string]any, len(params))
	for name, value := range params {
		switch v := value.(type) {
		case i18n.Text:
			out[name] = v.In(lang)
		case RejectReason:
			text := cat.T(lang, "notify.reject_code."+v.Code, nil)
			if v.Note != nil {
				if note := strings.TrimSpace(*v.Note); note != "" {
					text += "\n" + note
				}
			}
			out[name] = text
		default:
			out[name] = fmt.Sprint(v)
		}
	}
	return out
}
