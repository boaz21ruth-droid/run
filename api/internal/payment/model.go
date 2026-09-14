// Package payment 是收款模块：收款账户、文件读取，以及凭证上传与审核（Task 15 起）。
package payment

import "time"

// payment_accounts.provider 与 scope 的取值。
const (
	ProviderABA    = "ABA"
	ProviderACLEDA = "ACLEDA"
	ProviderWing   = "WING"
	ProviderBakong = "BAKONG"
	ProviderOther  = "OTHER"

	ScopeRegistration = "REGISTRATION"
	ScopeMerch        = "MERCH"
	ScopeAll          = "ALL"
)

// AccountInput 是后台新建或修改收款账户的输入。币种恒为 USD，不由输入决定。
type AccountInput struct {
	Name, Provider, AccountName, AccountNoMasked string
	Scope                                        string
	EventID                                      *int64 // nil = 全局
	Active                                       bool
}

// Account 是收款账户。
type Account struct {
	ID        int64
	Input     AccountInput
	Currency  string
	QRFileID  int64
	CreatedAt time.Time
}
