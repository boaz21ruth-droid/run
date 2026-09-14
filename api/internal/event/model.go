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
	ID        int64
	Code      string
	Name      i18n.Text
	DistanceM int32
	Capacity  int32
	StartAt   *time.Time
	CutoffAt  *time.Time
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
	Categories           []Category
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
