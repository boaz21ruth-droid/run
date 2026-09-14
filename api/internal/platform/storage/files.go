package storage

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/storage/store"
)

// FileRecord 是写 files 表的输入。
type FileRecord struct {
	StorageKey     string
	Visibility     string // PUBLIC | PRIVATE
	Purpose        string // PAYMENT_PROOF | PAYMENT_QR
	Image          Image
	UploadedByType string // USER | STAFF
	UploadedByID   int64
}

// File 是读取文件时需要的元数据。
type File struct {
	ID         int64
	StorageKey string
	Visibility string
	MIME       string
	SizeBytes  int64
	SHA256     []byte
}

// InsertFile 在调用方事务里写 files，返回新行 id。
func InsertFile(ctx context.Context, tx pgx.Tx, rec FileRecord) (int64, error) {
	width := int32(rec.Image.Width)
	height := int32(rec.Image.Height)
	uploader := rec.UploadedByID
	id, err := store.New(tx).InsertFile(ctx, store.InsertFileParams{
		StorageKey:     rec.StorageKey,
		Visibility:     rec.Visibility,
		Purpose:        rec.Purpose,
		MimeType:       rec.Image.MIME,
		SizeBytes:      int64(len(rec.Image.Data)),
		Sha256:         rec.Image.SHA256[:],
		Width:          &width,
		Height:         &height,
		UploadedByType: rec.UploadedByType,
		UploadedByID:   &uploader,
	})
	if err != nil {
		return 0, fmt.Errorf("storage: insert file %s: %w", rec.StorageKey, err)
	}
	return id, nil
}

// GetFile 读取文件元数据；不存在返回 NOT_FOUND(404)。
func GetFile(ctx context.Context, q store.DBTX, id int64) (File, error) {
	row, err := store.New(q).GetFile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	if err != nil {
		return File{}, fmt.Errorf("storage: get file %d: %w", id, err)
	}
	return File{
		ID:         row.ID,
		StorageKey: row.StorageKey,
		Visibility: row.Visibility,
		MIME:       row.MimeType,
		SizeBytes:  row.SizeBytes,
		SHA256:     row.Sha256,
	}, nil
}

// CountOtherFilesWithSHA256 统计同用途、内容相同、id 不等于 excludeID 的文件数（重复截图检测）。
func CountOtherFilesWithSHA256(ctx context.Context, tx pgx.Tx, sha []byte, purpose string, excludeID int64) (int64, error) {
	n, err := store.New(tx).CountOtherFilesWithSHA256(ctx, store.CountOtherFilesWithSHA256Params{
		Sha256:    sha,
		Purpose:   purpose,
		ExcludeID: excludeID,
	})
	if err != nil {
		return 0, fmt.Errorf("storage: count files by sha256: %w", err)
	}
	return n, nil
}
