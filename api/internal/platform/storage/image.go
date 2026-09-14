package storage

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // 注册 jpeg 解码器
	_ "image/png"  // 注册 png 解码器
	"io"
	"net/http"

	_ "golang.org/x/image/webp" // 注册 webp 解码器

	"werun/api/internal/platform/apperr"
)

// Image 是通过校验的上传图片。
type Image struct {
	Data   []byte
	MIME   string // image/jpeg | image/png | image/webp
	Ext    string // jpg | png | webp
	SHA256 [32]byte
	Width  int
	Height int
}

var extByMIME = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
}

var mimeByFormat = map[string]string{
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"webp": "image/webp",
}

// ReadImage 读取至多 maxBytes+1 字节；超限返回 FILE_TOO_LARGE(413)。
// 类型按前 512 字节内容识别（不看文件名），不在白名单或解不出宽高时返回 FILE_TYPE_NOT_ALLOWED(415)。
func ReadImage(r io.Reader, maxBytes int64) (Image, error) {
	tooLarge := apperr.New(http.StatusRequestEntityTooLarge, apperr.CodeFileTooLarge).
		WithParams(map[string]any{"maxMB": maxBytes >> 20})

	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return Image{}, tooLarge.Wrap(err)
		}
		return Image{}, fmt.Errorf("storage: read upload: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return Image{}, tooLarge
	}

	notAllowed := apperr.New(http.StatusUnsupportedMediaType, apperr.CodeFileTypeNotAllowed)
	if len(data) == 0 {
		return Image{}, notAllowed
	}
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	mime := http.DetectContentType(head)
	ext, ok := extByMIME[mime]
	if !ok {
		return Image{}, notAllowed
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Image{}, notAllowed.Wrap(err)
	}
	if mimeByFormat[format] != mime || cfg.Width <= 0 || cfg.Height <= 0 {
		return Image{}, notAllowed
	}
	return Image{
		Data:   data,
		MIME:   mime,
		Ext:    ext,
		SHA256: sha256.Sum256(data),
		Width:  cfg.Width,
		Height: cfg.Height,
	}, nil
}
