package storage_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/storage"
)

// 1×1 无损 WebP（34 字节）
var tinyWebP = []byte("RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00\x2f\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00")

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, w, h)), nil))
	return buf.Bytes()
}

func requireAppErr(t *testing.T, err error, code string, status int) {
	t.Helper()
	ae, ok := apperr.As(err)
	require.Truef(t, ok, "期望 *apperr.Error，得到 %v", err)
	assert.Equal(t, code, ae.Code)
	assert.Equal(t, status, ae.Status)
}

func TestReadImageAcceptsJPEGPNGWebP(t *testing.T) {
	cases := []struct {
		name          string
		data          []byte
		mime, ext     string
		width, height int
	}{
		{"png", pngBytes(t, 3, 2), "image/png", "png", 3, 2},
		{"jpeg", jpegBytes(t, 4, 5), "image/jpeg", "jpg", 4, 5},
		{"webp", tinyWebP, "image/webp", "webp", 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			img, err := storage.ReadImage(bytes.NewReader(tc.data), storage.MaxQRBytes)

			require.NoError(t, err)
			assert.Equal(t, tc.mime, img.MIME)
			assert.Equal(t, tc.ext, img.Ext)
			assert.Equal(t, tc.width, img.Width)
			assert.Equal(t, tc.height, img.Height)
			assert.Equal(t, tc.data, img.Data)
			assert.Equal(t, sha256.Sum256(tc.data), img.SHA256)
		})
	}
}

func TestReadImageSizeLimit(t *testing.T) {
	data := pngBytes(t, 2, 2)

	_, err := storage.ReadImage(bytes.NewReader(data), int64(len(data)))
	require.NoError(t, err, "恰好等于上限可以通过")

	_, err = storage.ReadImage(bytes.NewReader(data), int64(len(data)-1))
	requireAppErr(t, err, apperr.CodeFileTooLarge, http.StatusRequestEntityTooLarge)
	ae, _ := apperr.As(err)
	assert.Equal(t, int64(0), ae.Params["maxMB"])

	huge := io.MultiReader(bytes.NewReader(data), strings.NewReader(strings.Repeat("x", storage.MaxProofBytes)))
	_, err = storage.ReadImage(huge, storage.MaxProofBytes)
	requireAppErr(t, err, apperr.CodeFileTooLarge, http.StatusRequestEntityTooLarge)
}

type maxBytesReader struct{}

func (maxBytesReader) Read([]byte) (int, error) { return 0, &http.MaxBytesError{Limit: 6 << 20} }

func TestReadImageMapsRequestBodyLimitToFileTooLarge(t *testing.T) {
	_, err := storage.ReadImage(maxBytesReader{}, storage.MaxProofBytes)
	requireAppErr(t, err, apperr.CodeFileTooLarge, http.StatusRequestEntityTooLarge)
}

func TestReadImageRejectsNonImages(t *testing.T) {
	gif := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
	truncatedPNG := pngBytes(t, 2, 2)[:20]
	cases := map[string][]byte{
		"空文件":          {},
		"文本伪装成 png":    []byte("this is not an image, just text named proof.png"),
		"gif 不在白名单":    gif,
		"png 文件头但无法解码": truncatedPNG,
		"pdf":          []byte("%PDF-1.7\n1 0 obj\n"),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := storage.ReadImage(bytes.NewReader(data), storage.MaxProofBytes)
			requireAppErr(t, err, apperr.CodeFileTypeNotAllowed, http.StatusUnsupportedMediaType)
		})
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("disk on fire") }

func TestReadImageReturnsReadErrors(t *testing.T) {
	_, err := storage.ReadImage(failingReader{}, storage.MaxProofBytes)
	require.ErrorContains(t, err, "disk on fire")
	_, isAppErr := apperr.As(err)
	assert.False(t, isAppErr)
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
