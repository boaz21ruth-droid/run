// Package storage 保存上传文件：Store 接口与本地磁盘实现、图片识别、files 表读写。
package storage

import (
	"context"
	"errors"
	"io"
)

// 上传大小上限。
const (
	MaxProofBytes = 5 << 20 // 付款凭证截图
	MaxQRBytes    = 2 << 20 // 收款二维码
)

// files.visibility 与 files.purpose 的取值。
const (
	VisibilityPublic    = "PUBLIC"
	VisibilityPrivate   = "PRIVATE"
	PurposePaymentProof = "PAYMENT_PROOF"
	PurposePaymentQR    = "PAYMENT_QR"
)

// ErrNotFound 表示存储中没有该 key。
var ErrNotFound = errors.New("storage: not found")

// Store 是文件内容的存取接口；元数据在 files 表。
type Store interface {
	Put(ctx context.Context, key string, r io.Reader) error
	Open(ctx context.Context, key string) (io.ReadCloser, error) // 不存在时返回 ErrNotFound
	Delete(ctx context.Context, key string) error                // 不存在时返回 nil
}
