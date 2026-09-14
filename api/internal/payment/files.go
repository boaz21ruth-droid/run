package payment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/storage"
)

// OpenPublicFile 打开 PUBLIC 文件（收款二维码）；私有、不存在或存储里缺失都返回 NOT_FOUND。调用方负责关闭。
func (s *Service) OpenPublicFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error) {
	file, err := storage.GetFile(ctx, s.pool, id)
	if err != nil {
		return storage.File{}, nil, err
	}
	if file.Visibility != storage.VisibilityPublic {
		return storage.File{}, nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound)
	}
	return s.open(ctx, file)
}

// OpenPrivateFile 供后台（已鉴权的员工接口）打开任意可见性的文件。调用方负责关闭。
func (s *Service) OpenPrivateFile(ctx context.Context, id int64) (storage.File, io.ReadCloser, error) {
	file, err := storage.GetFile(ctx, s.pool, id)
	if err != nil {
		return storage.File{}, nil, err
	}
	return s.open(ctx, file)
}

func (s *Service) open(ctx context.Context, file storage.File) (storage.File, io.ReadCloser, error) {
	rc, err := s.files.Open(ctx, file.StorageKey)
	if errors.Is(err, storage.ErrNotFound) {
		return storage.File{}, nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound).Wrap(err)
	}
	if err != nil {
		return storage.File{}, nil, fmt.Errorf("open file %d: %w", file.ID, err)
	}
	return file, rc, nil
}
