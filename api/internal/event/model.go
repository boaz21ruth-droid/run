// Package event 是赛事模块：赛事与组别的创建、发布、公开查询。
package event

import (
	"time"

	"werun/api/internal/platform/i18n"
)

const (
	StatusDraft     = "DRAFT"
	StatusPublished = "PUBLISHED"

	TypeRace         = "RACE"
	TypeFreeActivity = "FREE_ACTIVITY"

	OrganizerOfficial = "OFFICIAL"
	OrganizerPartner  = "PARTNER"
)

// Category 是赛事下的组别（21K / 10K / 5K）。
type Category struct {
	ID            int64
	Code          string
	Name          i18n.Text
	DistanceM     int32
	Capacity      int32
	StartAt       *time.Time
	CutoffAt      *time.Time
	MinAge        int16
	UsedCount     int32
	ReservedCount int32
	Qualification *Qualification // 精英组资格要求；普通组为 nil
}

// Qualification 是精英组的资格要求：报名自报最好成绩并附证明，核验不通过转到 FallbackCategoryID。
type Qualification struct {
	Rule               i18n.Text
	MaxMs              *int32 // 自报成绩上限；nil 表示不限，只看证明
	FallbackCategoryID int64
}

// RefundTier 是退改政策的一档：开赛前至少 Days 天申请退 Percent%。
type RefundTier struct {
	Days    int32 `json:"days"`
	Percent int32 `json:"percent"`
}

// RefundPolicy 是主办方设置的退改政策，存在 events.refund_policy。Tiers 按 Days 从大到小；
// TransferDays 为 nil 表示不接受转让。只用于展示，退款仍由财务按退款流程办理。
type RefundPolicy struct {
	Tiers        []RefundTier `json:"tiers"`
	TransferDays *int32       `json:"transferDays"`
}

// Event 是赛事及其组别。
type Event struct {
	ID                   int64
	Slug                 string
	EventType            string
	OrganizerType        string
	Name                 i18n.Text
	City                 string
	RaceDate             time.Time // 日期，UTC 零点
	Timezone             string
	Status               string // StatusDraft | StatusPublished
	PublicVisible        bool
	PublishedAt          *time.Time
	RegistrationOpen     bool
	RegistrationOpensAt  *time.Time
	RegistrationClosesAt *time.Time
	CoverFileID          *int64
	CompOpen             bool // 接受免费入场申请（comp_quota 非空）
	RefundPolicy         *RefundPolicy
	Categories           []Category
	// FromPriceCents 是当前在售价格档中的最低价（分）；仅公开列表/详情会填充，nil 表示没有在售价格档。
	FromPriceCents *int64
	// PriceTiers 是价格档时间线；仅公开列表/详情会填充。
	PriceTiers []PriceTier
}

// 价格档在公开页上的状态。
const (
	TierUpcoming = "UPCOMING" // 销售窗口还没开始
	TierOnSale   = "ON_SALE"
	TierSoldOut  = "SOLD_OUT" // 配额用尽
	TierEnded    = "ENDED"    // 销售窗口已结束
)

// PriceTier 是公开赛事页展示的一个价格档。
type PriceTier struct {
	ID           int64
	Name         i18n.Text
	Audience     string // ALL | LOCAL
	PriceCents   int64
	Currency     string
	Quota        *int32 // nil = 不限
	Remaining    *int32 // 配额剩余；不限时为 nil
	SaleStartsAt *time.Time
	SaleEndsAt   *time.Time
	State        string
}

// CategoryInput 是新建赛事时提交的组别。
type CategoryInput struct {
	Code      string
	Name      i18n.Text
	DistanceM int32
	Capacity  int32
	StartAt   *time.Time
	CutoffAt  *time.Time
}

// CreateInput 是新建赛事（草稿）的输入。
type CreateInput struct {
	Slug          string
	EventType     string
	OrganizerType string
	Name          i18n.Text
	City          string
	RaceDate      time.Time
	Categories    []CategoryInput
}

// RegistrationInput 是后台修改报名开关与报名时间的输入；时间为 nil 表示不限。
type RegistrationInput struct {
	Open     bool
	OpensAt  *time.Time
	ClosesAt *time.Time
}

// 开放报名校验中缺失项的取值（REGISTRATION_NOT_READY 的 Params["missing"]）。
const (
	MissingPublished      = "PUBLISHED"
	MissingPriceRule      = "PRICE_RULE"
	MissingPaymentAccount = "PAYMENT_ACCOUNT"
)
