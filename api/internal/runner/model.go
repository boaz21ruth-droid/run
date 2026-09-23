// Package runner 是跑者模块：Telegram 登录与手机号验证码登录、会话、常用参赛人、报名同意书。
package runner

import "time"

// User 是已登录的跑者。
type User struct {
	ID               int64
	Phone            string // E.164，可空
	TelegramUserID   int64
	TelegramUsername string
	DisplayName      string
	Locale           string // zh | en | km
}

// Session 是登录成功后返回给小程序的令牌。
type Session struct {
	Token     string
	ExpiresAt time.Time
	User      User
}

// TelegramUser 是 initData 里 user 字段中本系统使用的部分。
type TelegramUser struct {
	ID                                          int64
	FirstName, LastName, Username, LanguageCode string
}

// ProfileData 是一位参赛人的资料。
type ProfileData struct {
	FullName, Gender              string    // Gender: M | F | X
	BirthDate                     time.Time // 日期，UTC 零点
	Nationality                   string    // ISO 3166-1 alpha-2 大写
	IDType, IDNo                  string    // NATIONAL_ID | PASSPORT | OTHER；IDNo 为原始输入
	Phone, Email                  string    // Phone 为 E.164；Email 可空
	EmergencyName, EmergencyPhone string
	TShirtSize                    string // XS | S | M | L | XL | XXL
}

// Profile 是常用参赛人。Data.IDNo 恒为空串，只通过 IDNoMasked 展示后 4 位。
type Profile struct {
	ID         int64
	Data       ProfileData
	IDNoMasked string
	IsSelf     bool
}

// ConsentItem 是同意书里需要逐项勾选的一条。
type ConsentItem struct {
	Key, Title, Description string
}

// ConsentVersion 是一版已发布的同意书。
type ConsentVersion struct {
	Version, Lang string
	EffectiveDate time.Time
	FullText      string
	Items         []ConsentItem
}

// ConsentAcceptance 是跑者提交的签署内容。
type ConsentAcceptance struct {
	Version, Lang string
	CheckedItems  []string
}

// ConsentLink 指明签署记录关联的订单或免费报名，恰好一个非空。
type ConsentLink struct {
	RegOrderID, FreeSignupID *int64
}

// PublishConsentInput 是 werun publish-consent 的输入。
type PublishConsentInput struct {
	Purpose, Version, Lang string
	EffectiveDate          time.Time
	FullText               string
	Items                  []ConsentItem
}
