package payment

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
)

// maxTextPartBytes 是 multipart 文本字段的最大长度。
const maxTextPartBytes = 1024

// Handlers 实现 apigen.StrictServerInterface 中收款相关的操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AdminListPaymentAccounts(ctx context.Context, _ apigen.AdminListPaymentAccountsRequestObject) (apigen.AdminListPaymentAccountsResponseObject, error) {
	accounts, err := h.svc.ListAccounts(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.PaymentAccount, 0, len(accounts))
	for _, a := range accounts {
		items = append(items, toAPIAccount(a))
	}
	return apigen.AdminListPaymentAccounts200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreatePaymentAccount(ctx context.Context, req apigen.AdminCreatePaymentAccountRequestObject) (apigen.AdminCreatePaymentAccountResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	form, err := readAccountForm(req.Body)
	if err != nil {
		return nil, err
	}
	acc, err := h.svc.CreateAccount(ctx, actor, form.input, form.qr)
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreatePaymentAccount201JSONResponse(toAPIAccount(acc)), nil
}

func (h *Handlers) AdminUpdatePaymentAccount(ctx context.Context, req apigen.AdminUpdatePaymentAccountRequestObject) (apigen.AdminUpdatePaymentAccountResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	form, err := readAccountForm(req.Body)
	if err != nil {
		return nil, err
	}
	acc, err := h.svc.UpdateAccount(ctx, actor, req.Id, form.input, form.qr)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdatePaymentAccount200JSONResponse(toAPIAccount(acc)), nil
}

func (h *Handlers) GetPublicFile(ctx context.Context, req apigen.GetPublicFileRequestObject) (apigen.GetPublicFileResponseObject, error) {
	file, rc, err := h.svc.OpenPublicFile(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	// 响应头不在 OpenAPI 中声明（契约补充 9），生成的响应写出前由 gin 带上
	if c, ok := httpx.Gin(ctx); ok {
		c.Header("Cache-Control", "public, max-age=86400")
	}
	return apigen.GetPublicFile200ImageResponse{Body: rc, ContentType: file.MIME, ContentLength: file.SizeBytes}, nil
}

type accountForm struct {
	input AccountInput
	qr    io.Reader // 没有 qr part 或内容为空时为 nil
}

// readAccountForm 逐个读取 multipart part：qr 最多读 MaxQRBytes+1 字节（超限由 ReadImage 报 FILE_TOO_LARGE），
// 其余为文本字段。active 缺省为 true，eventId 空串表示全局。
func readAccountForm(r *multipart.Reader) (accountForm, error) {
	form := accountForm{input: AccountInput{Active: true}}
	verr := validationError()
	failed := false
	for {
		part, err := r.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return accountForm{}, multipartError(err, storage.MaxQRBytes)
		}
		name := part.FormName()
		if name == "qr" {
			data, err := io.ReadAll(io.LimitReader(part, storage.MaxQRBytes+1))
			if err != nil {
				return accountForm{}, multipartError(err, storage.MaxQRBytes)
			}
			if len(data) > 0 {
				form.qr = bytes.NewReader(data)
			}
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(part, maxTextPartBytes+1))
		if err != nil {
			return accountForm{}, multipartError(err, storage.MaxQRBytes)
		}
		if len(raw) > maxTextPartBytes {
			return accountForm{}, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
		}
		value := string(raw)
		switch name {
		case "name":
			form.input.Name = value
		case "provider":
			form.input.Provider = value
		case "accountName":
			form.input.AccountName = value
		case "accountNoMasked":
			form.input.AccountNoMasked = value
		case "scope":
			form.input.Scope = value
		case "eventId":
			trimmed := strings.TrimSpace(value)
			if trimmed == "" {
				form.input.EventID = nil
				continue
			}
			id, err := strconv.ParseInt(trimmed, 10, 64)
			if err != nil || id <= 0 {
				verr = verr.WithField("eventId", "field.invalid", nil)
				failed = true
				continue
			}
			form.input.EventID = &id
		case "active":
			switch value {
			case "true":
				form.input.Active = true
			case "false":
				form.input.Active = false
			default:
				verr = verr.WithField("active", "field.invalid", nil)
				failed = true
			}
		}
	}
	if failed {
		return accountForm{}, verr
	}
	return form, nil
}

// multipartError 把读取 multipart part 时的错误映射成 apperr：*http.MaxBytesError（无论来自路由级
// body 上限还是调用方传入的 maxBytes 上限）映射为 FILE_TOO_LARGE(413)，文案参数 {maxMB} 取 maxBytes；
// 其余错误映射为 BAD_REQUEST(400)。Task 15 复用本函数并传入 storage.MaxProofBytes。
func multipartError(err error, maxBytes int64) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return apperr.New(http.StatusRequestEntityTooLarge, apperr.CodeFileTooLarge).
			WithParams(map[string]any{"maxMB": maxBytes >> 20}).Wrap(err)
	}
	return apperr.New(http.StatusBadRequest, apperr.CodeBadRequest).Wrap(err)
}

func toAPIAccount(a Account) apigen.PaymentAccount {
	return apigen.PaymentAccount{
		Id:              a.ID,
		Name:            a.Input.Name,
		Provider:        apigen.PaymentProvider(a.Input.Provider),
		AccountName:     a.Input.AccountName,
		AccountNoMasked: a.Input.AccountNoMasked,
		Currency:        a.Currency,
		QrFileId:        a.QRFileID,
		Scope:           apigen.PaymentAccountScope(a.Input.Scope),
		EventId:         a.Input.EventID,
		Active:          a.Input.Active,
		CreatedAt:       a.CreatedAt,
	}
}
