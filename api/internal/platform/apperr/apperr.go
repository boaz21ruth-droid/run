// Package apperr 定义带错误码的业务错误。service 与 handler 只返回 *Error，
// 由 httpx.WriteError 统一转换为 HTTP 响应与三语文案。
package apperr

import (
	"errors"
	"maps"
)

// 错误码。每个错误码在 i18n/messages.{zh,en,km}.json 中都有同名文案。
const (
	CodeInternal                  = "INTERNAL"
	CodeBadRequest                = "BAD_REQUEST"
	CodeValidation                = "VALIDATION_FAILED"
	CodeUnauthenticated           = "UNAUTHENTICATED"
	CodeForbidden                 = "FORBIDDEN"
	CodeCSRF                      = "CSRF_HEADER_MISSING"
	CodeNotFound                  = "NOT_FOUND"
	CodeRateLimited               = "RATE_LIMITED"
	CodeInvalidCredentials        = "INVALID_CREDENTIALS"
	CodeAccountLocked             = "ACCOUNT_LOCKED"
	CodeEventNotFound             = "EVENT_NOT_FOUND"
	CodeEventSlugTaken            = "EVENT_SLUG_TAKEN"
	CodeEventCategoryCodeTaken    = "EVENT_CATEGORY_CODE_TAKEN"
	CodeEventAlreadyPublished     = "EVENT_ALREADY_PUBLISHED"
	CodeEventNoCategory           = "EVENT_NO_CATEGORY"
	CodeEventCategoryIncomplete   = "EVENT_CATEGORY_INCOMPLETE"
	CodeFileTooLarge              = "FILE_TOO_LARGE"
	CodeFileTypeNotAllowed        = "FILE_TYPE_NOT_ALLOWED"
	CodeRegistrationNotReady      = "REGISTRATION_NOT_READY"
	CodePriceRuleLocked           = "PRICE_RULE_LOCKED"
	CodeCouponCodeTaken           = "COUPON_CODE_TAKEN"
	CodeTelegramAuthInvalid       = "TELEGRAM_AUTH_INVALID"
	CodeConsentInvalid            = "CONSENT_INVALID"
	CodeCouponInvalid             = "COUPON_INVALID"
	CodeCouponExhausted           = "COUPON_EXHAUSTED"
	CodeCategorySoldOut           = "CATEGORY_SOLD_OUT"
	CodePriceTierSoldOut          = "PRICE_TIER_SOLD_OUT"
	CodeRegistrationClosed        = "REGISTRATION_CLOSED"
	CodeAlreadyRegistered         = "ALREADY_REGISTERED"
	CodePaymentAccountUnavailable = "PAYMENT_ACCOUNT_UNAVAILABLE"
	CodeIdempotencyKeyReused      = "IDEMPOTENCY_KEY_REUSED"
	CodeOrderStateConflict        = "ORDER_STATE_CONFLICT"
	CodeOrderNotFound             = "ORDER_NOT_FOUND"
)

// AllCodes 列出全部错误码，供文案完整性测试使用。新增错误码时必须同时加到这里。
var AllCodes = []string{
	CodeInternal,
	CodeBadRequest,
	CodeValidation,
	CodeUnauthenticated,
	CodeForbidden,
	CodeCSRF,
	CodeNotFound,
	CodeRateLimited,
	CodeInvalidCredentials,
	CodeAccountLocked,
	CodeEventNotFound,
	CodeEventSlugTaken,
	CodeEventCategoryCodeTaken,
	CodeEventAlreadyPublished,
	CodeEventNoCategory,
	CodeEventCategoryIncomplete,
	CodeFileTooLarge,
	CodeFileTypeNotAllowed,
	CodeRegistrationNotReady,
	CodePriceRuleLocked,
	CodeCouponCodeTaken,
	CodeTelegramAuthInvalid,
	CodeConsentInvalid,
	CodeCouponInvalid,
	CodeCouponExhausted,
	CodeCategorySoldOut,
	CodePriceTierSoldOut,
	CodeRegistrationClosed,
	CodeAlreadyRegistered,
	CodePaymentAccountUnavailable,
	CodeIdempotencyKeyReused,
	CodeOrderStateConflict,
	CodeOrderNotFound,
}

// FieldError 描述某个字段的错误：文案 key 与参数。
type FieldError struct {
	Key    string
	Params map[string]any
}

// Error 是带错误码与 HTTP 状态的业务错误。
type Error struct {
	Code   string
	Status int
	Fields map[string]FieldError
	Params map[string]any
	Err    error
}

// New 创建错误。status 为 HTTP 状态码，code 取本包 Code… 常量。
func New(status int, code string) *Error {
	return &Error{Code: code, Status: status}
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Code + ": " + e.Err.Error()
	}
	return e.Code
}

func (e *Error) Unwrap() error {
	return e.Err
}

func (e *Error) clone() *Error {
	c := *e
	c.Fields = maps.Clone(e.Fields)
	c.Params = maps.Clone(e.Params)
	return &c
}

// WithField 返回附加了字段错误的副本，原错误不变。
func (e *Error) WithField(field, key string, params map[string]any) *Error {
	c := e.clone()
	if c.Fields == nil {
		c.Fields = map[string]FieldError{}
	}
	c.Fields[field] = FieldError{Key: key, Params: params}
	return c
}

// WithParams 返回替换了顶层文案参数的副本，原错误不变。
func (e *Error) WithParams(params map[string]any) *Error {
	c := e.clone()
	c.Params = maps.Clone(params)
	return c
}

// Wrap 返回记录了原始错误的副本。原始错误只进日志，不返回给前端。
func (e *Error) Wrap(err error) *Error {
	c := e.clone()
	c.Err = err
	return c
}

// As 在错误链中查找 *Error。
func As(err error) (*Error, bool) {
	var ae *Error
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}
