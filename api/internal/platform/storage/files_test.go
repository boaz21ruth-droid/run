package storage_test

import (
	"context"
	"crypto/sha256"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/dbtest"
	"werun/api/internal/platform/storage"
)

func TestInsertGetAndCountFiles(t *testing.T) {
	pool := dbtest.NewPool(t)
	ctx := context.Background()
	data := pngBytes(t, 3, 2)
	img, err := storage.ReadImage(bytesReader(data), storage.MaxProofBytes)
	require.NoError(t, err)

	var firstID, secondID, otherPurposeID int64
	require.NoError(t, db.InTx(ctx, pool, func(tx pgx.Tx) error {
		var err error
		firstID, err = storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey: "2026/09/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", Visibility: storage.VisibilityPrivate,
			Purpose: storage.PurposePaymentProof, Image: img, UploadedByType: "USER", UploadedByID: 42,
		})
		if err != nil {
			return err
		}
		secondID, err = storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey: "2026/09/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png", Visibility: storage.VisibilityPrivate,
			Purpose: storage.PurposePaymentProof, Image: img, UploadedByType: "USER", UploadedByID: 43,
		})
		if err != nil {
			return err
		}
		otherPurposeID, err = storage.InsertFile(ctx, tx, storage.FileRecord{
			StorageKey: "2026/09/cccccccccccccccccccccccccccccccc.png", Visibility: storage.VisibilityPublic,
			Purpose: storage.PurposePaymentQR, Image: img, UploadedByType: "STAFF", UploadedByID: 1,
		})
		return err
	}))

	f, err := storage.GetFile(ctx, pool, firstID)
	require.NoError(t, err)
	sum := sha256.Sum256(data)
	assert.Equal(t, storage.File{
		ID: firstID, StorageKey: "2026/09/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", Visibility: "PRIVATE",
		MIME: "image/png", SizeBytes: int64(len(data)), SHA256: sum[:],
	}, f)

	var width, height int32
	var uploader int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT width, height, uploaded_by_id FROM files WHERE id = $1`, firstID).
		Scan(&width, &height, &uploader))
	assert.Equal(t, []any{int32(3), int32(2), int64(42)}, []any{width, height, uploader})

	require.NoError(t, db.InTx(ctx, pool, func(tx pgx.Tx) error {
		n, err := storage.CountOtherFilesWithSHA256(ctx, tx, sum[:], storage.PurposePaymentProof, firstID)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n, "只数其他凭证文件，不含自己，也不含二维码")
		n, err = storage.CountOtherFilesWithSHA256(ctx, tx, sum[:], storage.PurposePaymentQR, otherPurposeID)
		require.NoError(t, err)
		assert.Equal(t, int64(0), n)
		_ = secondID
		return nil
	}))

	_, err = storage.GetFile(ctx, pool, 999999)
	ae, ok := apperr.As(err)
	require.True(t, ok)
	assert.Equal(t, apperr.CodeNotFound, ae.Code)
	assert.Equal(t, http.StatusNotFound, ae.Status)
}
