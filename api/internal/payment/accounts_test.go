package payment_test

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/event"
	"werun/api/internal/iam"
	"werun/api/internal/payment"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/platform/storage"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))))
	return buf.Bytes()
}

func fieldKeys(t *testing.T, err error) map[string]string {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	out := make(map[string]string, len(ae.Fields))
	for field, fe := range ae.Fields {
		out[field] = fe.Key
	}
	return out
}

type accountsFixture struct {
	svc   *payment.Service
	pool  *pgxpool.Pool
	disk  *storage.Disk
	root  string
	actor iam.Staff
	event event.Event
}

func newAccountsFixture(t *testing.T) accountsFixture {
	t.Helper()
	ctx := context.Background()
	pool := dbtest.NewPool(t)
	root := t.TempDir()
	disk, err := storage.NewDisk(root)
	require.NoError(t, err)
	iamSvc := iam.NewService(pool, []byte(strings.Repeat("s", 32)), iam.NewLoginLimiter(time.Now), time.Now)
	actor, err := iamSvc.CreateStaff(ctx, "finance.accounts", "Finance Accounts", iam.RoleFinance, "Correct-Horse-Battery-9")
	require.NoError(t, err)
	ev, err := event.NewService(pool).Create(ctx, actor, event.CreateInput{
		Slug: "pphm-2026", EventType: event.TypeRace, OrganizerType: event.OrganizerOfficial,
		Name: i18n.Text{i18n.ZH: "金边半马", i18n.EN: "PP Half", i18n.KM: "ពាក់កណ្ដាលម៉ារ៉ាតុង"},
		City: "Phnom Penh", RaceDate: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)
	now := func() time.Time { return time.Date(2026, 9, 14, 3, 0, 0, 0, time.UTC) }
	return accountsFixture{svc: payment.NewService(pool, disk, now), pool: pool, disk: disk, root: root, actor: actor, event: ev}
}

func (f accountsFixture) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, f.pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

// storedFiles 统计存储根目录下的普通文件数。
func (f accountsFixture) storedFiles(t *testing.T) int {
	t.Helper()
	n := 0
	require.NoError(t, filepath.WalkDir(f.root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			n++
		}
		return err
	}))
	return n
}

func validAccount(eventID *int64) payment.AccountInput {
	return payment.AccountInput{
		Name:            " ABA USD 主收款户 ",
		Provider:        "ABA",
		AccountName:     "WERUN SPORTS CO LTD",
		AccountNoMasked: "*** *** 123",
		Scope:           payment.ScopeRegistration,
		EventID:         eventID,
		Active:          true,
	}
}

func TestValidateAccount(t *testing.T) {
	require.NoError(t, payment.ValidateAccount(validAccount(nil)))

	cases := []struct {
		name   string
		mutate func(in *payment.AccountInput)
		field  string
		key    string
	}{
		{"名称为空", func(in *payment.AccountInput) { in.Name = "  " }, "name", "field.required"},
		{"名称过长", func(in *payment.AccountInput) { in.Name = strings.Repeat("a", 81) }, "name", "field.too_long"},
		{"渠道不在枚举内", func(in *payment.AccountInput) { in.Provider = "PAYPAL" }, "provider", "field.invalid"},
		{"户名为空", func(in *payment.AccountInput) { in.AccountName = "" }, "accountName", "field.required"},
		{"尾号过长", func(in *payment.AccountInput) { in.AccountNoMasked = strings.Repeat("*", 33) }, "accountNoMasked", "field.too_long"},
		{"范围不在枚举内", func(in *payment.AccountInput) { in.Scope = "DONATION" }, "scope", "field.invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validAccount(nil)
			tc.mutate(&in)
			require.Equal(t, tc.key, fieldKeys(t, payment.ValidateAccount(in))[tc.field])
		})
	}
}

func TestCreateAccountStoresPublicQRAndAudits(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	qr := pngBytes(t, 4, 4)

	acc, err := f.svc.CreateAccount(ctx, f.actor, validAccount(&f.event.ID), bytes.NewReader(qr))

	require.NoError(t, err)
	assert.NotZero(t, acc.ID)
	assert.Equal(t, "ABA USD 主收款户", acc.Input.Name, "去掉首尾空白")
	assert.Equal(t, "USD", acc.Currency)
	assert.Equal(t, f.event.ID, *acc.Input.EventID)
	assert.True(t, acc.Input.Active)
	assert.False(t, acc.CreatedAt.IsZero())
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM files WHERE id = $1 AND visibility = 'PUBLIC' AND purpose = 'PAYMENT_QR'
		   AND uploaded_by_type = 'STAFF' AND uploaded_by_id = $2 AND mime_type = 'image/png'
		   AND storage_key LIKE '2026/09/%.png'`, acc.QRFileID, f.actor.ID))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'payment_account.create' AND entity_type = 'payment_account'
		   AND entity_id = $1 AND event_id = $2 AND is_financial`, acc.ID, f.event.ID))

	file, rc, err := f.svc.OpenPublicFile(ctx, acc.QRFileID)
	require.NoError(t, err)
	body, err := io.ReadAll(rc)
	require.NoError(t, err)
	require.NoError(t, rc.Close())
	assert.Equal(t, qr, body)
	assert.Equal(t, "image/png", file.MIME)
	assert.Equal(t, int64(len(qr)), file.SizeBytes)

	list, err := f.svc.ListAccounts(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, acc.ID, list[0].ID)
}

func TestCreateAccountRejectsBadInputWithoutLeavingFiles(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()

	_, err := f.svc.CreateAccount(ctx, f.actor, validAccount(nil), nil)
	assert.Equal(t, "field.required", fieldKeys(t, err)["qr"])

	_, err = f.svc.CreateAccount(ctx, f.actor, validAccount(nil), strings.NewReader("definitely not an image"))
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeFileTypeNotAllowed, ae.Code)

	tooBig := append(pngBytes(t, 2, 2), make([]byte, storage.MaxQRBytes)...)
	_, err = f.svc.CreateAccount(ctx, f.actor, validAccount(nil), bytes.NewReader(tooBig))
	ae, ok = apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeFileTooLarge, ae.Code)
	assert.Equal(t, http.StatusRequestEntityTooLarge, ae.Status)

	missing := int64(999999)
	_, err = f.svc.CreateAccount(ctx, f.actor, validAccount(&missing), bytes.NewReader(pngBytes(t, 2, 2)))
	assert.Equal(t, "field.invalid", fieldKeys(t, err)["eventId"])

	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM payment_accounts`))
	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM files`))
	assert.Equal(t, 0, f.storedFiles(t), "事务失败后删除已写入存储的文件")
}

func TestUpdateAccountKeepsOrReplacesQR(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	acc, err := f.svc.CreateAccount(ctx, f.actor, validAccount(nil), bytes.NewReader(pngBytes(t, 4, 4)))
	require.NoError(t, err)

	renamed := validAccount(&f.event.ID)
	renamed.Name = "ABA USD 备用"
	renamed.Active = false
	renamed.Scope = payment.ScopeAll
	kept, err := f.svc.UpdateAccount(ctx, f.actor, acc.ID, renamed, nil)
	require.NoError(t, err)
	assert.Equal(t, acc.QRFileID, kept.QRFileID)
	assert.Equal(t, "ABA USD 备用", kept.Input.Name)
	assert.False(t, kept.Input.Active)
	assert.Equal(t, payment.ScopeAll, kept.Input.Scope)

	replaced, err := f.svc.UpdateAccount(ctx, f.actor, acc.ID, renamed, bytes.NewReader(pngBytes(t, 8, 8)))
	require.NoError(t, err)
	assert.NotEqual(t, acc.QRFileID, replaced.QRFileID)
	assert.Equal(t, 2, f.count(t, `SELECT count(*) FROM files WHERE purpose = 'PAYMENT_QR'`), "旧二维码文件行保留")
	assert.Equal(t, 2, f.storedFiles(t))
	_, oldRC, err := f.svc.OpenPublicFile(ctx, acc.QRFileID)
	require.NoError(t, err)
	require.NoError(t, oldRC.Close())
	assert.Equal(t, 2, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'payment_account.update' AND entity_id = $1 AND is_financial`, acc.ID))
	assert.Equal(t, 1, f.count(t,
		`SELECT count(*) FROM audit_logs WHERE action = 'payment_account.update'
		   AND before_data->>'active' = 'true' AND after_data->>'active' = 'false'`))

	_, err = f.svc.UpdateAccount(ctx, f.actor, 999999, renamed, bytes.NewReader(pngBytes(t, 2, 2)))
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
	assert.Equal(t, 2, f.storedFiles(t), "失败的更新不留下新文件")
}

func TestOpenFilesByVisibility(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	require.NoError(t, f.disk.Put(ctx, "2026/09/private.png", bytes.NewReader([]byte("proof"))))
	var privateID, danglingID int64
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/private.png', 'PRIVATE', 'PAYMENT_PROOF', 'image/png', 5, '\x01', 'USER') RETURNING id`).Scan(&privateID))
	require.NoError(t, f.pool.QueryRow(ctx,
		`INSERT INTO files (storage_key, visibility, purpose, mime_type, size_bytes, sha256, uploaded_by_type)
		 VALUES ('2026/09/gone.png', 'PUBLIC', 'PAYMENT_QR', 'image/png', 5, '\x02', 'STAFF') RETURNING id`).Scan(&danglingID))

	notFound := func(err error) {
		t.Helper()
		ae, ok := apperr.As(err)
		require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
		assert.Equal(t, apperr.CodeNotFound, ae.Code)
	}

	_, _, err := f.svc.OpenPublicFile(ctx, privateID)
	notFound(err)
	_, _, err = f.svc.OpenPublicFile(ctx, 999999)
	notFound(err)
	_, _, err = f.svc.OpenPublicFile(ctx, danglingID)
	notFound(err)

	file, rc, err := f.svc.OpenPrivateFile(ctx, privateID)
	require.NoError(t, err)
	defer rc.Close()
	body, err := io.ReadAll(rc)
	require.NoError(t, err)
	assert.Equal(t, "proof", string(body))
	assert.Equal(t, "PRIVATE", file.Visibility)
}
