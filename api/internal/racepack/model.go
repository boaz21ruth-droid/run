// Package racepack 是领物核销站（v8 第 8 屏）：现场按参考码 / 号码布 / 姓名找人，
// 本人或代领发放，付款未核验的报名一律拦下。领物名单由 registrations 派生，
// race_pack_facts 只存当前事实，race_pack_scan_logs 只追加。
package racepack

import (
	"time"

	"werun/api/internal/platform/i18n"
)

// 扫码流水的动作与结果，与 race_pack_scan_logs 的 CHECK 约束一致。
const (
	ActionIssue    = "ISSUE"
	ActionUndo     = "UNDO"
	ActionVerifyID = "VERIFY_ID"

	OutcomeApplied  = "APPLIED"
	OutcomeAlready  = "ALREADY"
	OutcomeRejected = "REJECTED"
)

// 不能发放的原因。
const (
	BlockNotPaid   = "NOT_PAID"
	BlockCancelled = "CANCELLED"
)

// Event 是核销站可操作的赛事。
type Event struct {
	ID       int64
	Name     i18n.Text
	City     string
	RaceDate time.Time
	Timezone string
}

// Entry 是核销站上的一名参赛人。
type Entry struct {
	RegistrationID int64
	RegNo          string
	OrderNo        string
	Status         string // PENDING | CONFIRMED | CANCELLED
	OrderStatus    string
	FullName       string
	TshirtSize     *string
	PhoneLast4     *string
	Audience       string // ALL | LOCAL；LOCAL 领物前必须当面核验证件
	CategoryCode   string
	CategoryName   i18n.Text
	Bib            *string
	Picked         bool
	PickedAt       *time.Time
	PickedByName   *string
	ProxyName      *string
	IDVerified     bool
	BlockReason    *string
}

// Recent 是最近一次成功发放。
type Recent struct {
	RegistrationID int64
	FullName       string
	Bib            *string
	ProxyName      *string
	StaffName      string
	OccurredAt     time.Time
}

// Station 是核销站一屏的数据。
type Station struct {
	Event     Event
	Confirmed int32
	Picked    int32
	Recent    []Recent
	Results   []Entry
}

// IssueInput 是一次发放。
type IssueInput struct {
	ClientEventID [16]byte
	DeviceID      string
	ProxyName     *string
	IDVerified    bool
}

// UndoInput 是一次撤销。
type UndoInput struct {
	ClientEventID [16]byte
	DeviceID      string
	Reason        string
}

// Assignment 是一名员工对某个赛事的指派。
type Assignment struct {
	StaffID    int64
	Username   string
	FullName   string
	Role       string
	ValidFrom  time.Time
	ValidUntil time.Time
	Enabled    bool
}

// StaffMember 是员工列表的一行。
type StaffMember struct {
	ID       int64
	Username string
	FullName string
	Role     string
	Status   string
}
