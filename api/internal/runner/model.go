// Package runner 是跑者模块：Telegram 登录与会话、常用参赛人、报名同意书。
package runner

import "time"

// User 是已登录的跑者。
type User struct {
	ID               int64
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
