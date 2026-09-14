package httpapi_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
)

func testPNG(t *testing.T, size int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, size, size))))
	return buf.Bytes()
}

// accountForm 构造 multipart 请求体；qr 为 nil 时不带文件 part。
func accountForm(t *testing.T, fields map[string]string, qr []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for name, value := range fields {
		require.NoError(t, w.WriteField(name, value))
	}
	if qr != nil {
		part, err := w.CreateFormFile("qr", "qr.png")
		require.NoError(t, err)
		_, err = part.Write(qr)
		require.NoError(t, err)
	}
	require.NoError(t, w.Close())
	return &body, w.FormDataContentType()
}

func accountFields(eventID string) map[string]string {
	return map[string]string{
		"name":            "ABA USD 主收款户",
		"provider":        "ABA",
		"accountName":     "WERUN SPORTS CO LTD",
		"accountNoMasked": "*** 123",
		"scope":           "REGISTRATION",
		"eventId":         eventID,
		"active":          "true",
	}
}

func (e eventsEnv) doRaw(t *testing.T, method, path string, body io.Reader, contentType string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(context.Background(), method, path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set(httpx.HeaderClient, "admin")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func TestPaymentAccountsHTTP(t *testing.T) {
	env := newEventsEnv(t)
	ops := env.sessionCookie(t, iam.RoleOps, "ops.accounthttp")
	finance := env.sessionCookie(t, iam.RoleFinance, "finance.accounthttp")
	support := env.sessionCookie(t, iam.RoleSupport, "support.accounthttp")
	ev := env.createPublishedEvent(t, ops)
	qr := testPNG(t, 6)

	body, ct := accountForm(t, accountFields(""), qr)
	rec := env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, ops)
	require.Equal(t, http.StatusForbidden, rec.Code, "OPS 对 payment_account_manage 只读")

	body, ct = accountForm(t, accountFields(fmt.Sprint(ev.Id)), qr)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	created := eventsDecode[apigen.PaymentAccount](t, rec)
	require.Equal(t, "USD", created.Currency)
	require.Equal(t, ev.Id, *created.EventId)
	require.True(t, created.Active)
	require.NotZero(t, created.QrFileId)

	rec = env.do(t, http.MethodGet, "/api/admin/payment-accounts", nil, ops, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Len(t, eventsDecode[apigen.PaymentAccountList](t, rec).Items, 1)
	rec = env.do(t, http.MethodGet, "/api/admin/payment-accounts", nil, support, nil)
	require.Equal(t, http.StatusForbidden, rec.Code, "SUPPORT 没有 payment_account_manage")

	qrPath := fmt.Sprintf("/api/files/%d", created.QrFileId)
	rec = env.do(t, http.MethodGet, qrPath, nil, nil, nil)
	require.Equal(t, http.StatusOK, rec.Code, "公开文件不需要登录")
	require.Equal(t, "image/png", rec.Header().Get("Content-Type"))
	require.Equal(t, "public, max-age=86400", rec.Header().Get("Cache-Control"))
	require.Equal(t, fmt.Sprint(len(qr)), rec.Header().Get("Content-Length"))
	require.Equal(t, qr, rec.Body.Bytes())

	update := accountFields("")
	update["name"] = "ABA USD 备用"
	update["active"] = "false"
	body, ct = accountForm(t, update, nil)
	updatePath := fmt.Sprintf("/api/admin/payment-accounts/%d", created.Id)
	rec = env.doRaw(t, http.MethodPut, updatePath, body, ct, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	kept := eventsDecode[apigen.PaymentAccount](t, rec)
	require.Equal(t, created.QrFileId, kept.QrFileId, "不带 qr 时不换二维码")
	require.Nil(t, kept.EventId)
	require.False(t, kept.Active)

	body, ct = accountForm(t, update, testPNG(t, 9))
	rec = env.doRaw(t, http.MethodPut, updatePath, body, ct, finance)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotEqual(t, created.QrFileId, eventsDecode[apigen.PaymentAccount](t, rec).QrFileId)
	require.Equal(t, http.StatusOK, env.do(t, http.MethodGet, qrPath, nil, nil, nil).Code, "旧二维码仍可访问")

	invalid := accountFields("")
	invalid["provider"] = "PAYPAL"
	invalid["active"] = "maybe"
	body, ct = accountForm(t, invalid, qr)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "active")

	invalid["active"] = "true"
	body, ct = accountForm(t, invalid, qr)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "provider")

	body, ct = accountForm(t, accountFields(""), nil)
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Contains(t, eventsDecode[httpx.ErrorBody](t, rec).Error.Fields, "qr")

	body, ct = accountForm(t, accountFields(""), []byte("%PDF-1.7 not an image"))
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusUnsupportedMediaType, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeFileTypeNotAllowed, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	// 3 MB：没超过 6 MiB 请求体上限，但超过二维码 2 MB 上限
	body, ct = accountForm(t, accountFields(""), append(testPNG(t, 2), make([]byte, 3<<20)...))
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeFileTooLarge, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	// 7 MB：也超过路由 6 MiB 请求体上限（不是靠二维码字段自身的 2 MB 限制发现的）
	body, ct = accountForm(t, accountFields(""), append(testPNG(t, 2), make([]byte, 7<<20)...))
	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", body, ct, finance)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	require.Equal(t, apperr.CodeFileTooLarge, eventsDecode[httpx.ErrorBody](t, rec).Error.Code)

	rec = env.doRaw(t, http.MethodPost, "/api/admin/payment-accounts", strings.NewReader(`{"name":"x"}`), "application/json", finance)
	require.Equal(t, http.StatusBadRequest, rec.Code, "不是 multipart 请求")

	var privateID int64
	require.NoError(t, env.pool.QueryRow(context.Background(),
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/private-proof.png', 'PRIVATE', 'PAYMENT_PROOF', 'image/png', 5, '\x01', 'USER') RETURNING id`).Scan(&privateID))
	rec = env.do(t, http.MethodGet, fmt.Sprintf("/api/files/%d", privateID), nil, nil, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Empty(t, rec.Header().Get("Cache-Control"))
	rec = env.do(t, http.MethodGet, "/api/files/999999", nil, nil, nil)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
