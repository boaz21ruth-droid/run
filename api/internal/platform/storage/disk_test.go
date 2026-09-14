package storage_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/storage"
)

func TestNewDiskCreatesRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "files")

	_, err := storage.NewDisk(root)

	require.NoError(t, err)
	info, err := os.Stat(root)
	require.NoError(t, err)
	assert.True(t, info.IsDir())

	_, err = storage.NewDisk("")
	assert.Error(t, err)
}

func TestDiskPutOpenDelete(t *testing.T) {
	root := t.TempDir()
	disk, err := storage.NewDisk(root)
	require.NoError(t, err)
	ctx := context.Background()
	var _ storage.Store = disk

	require.NoError(t, disk.Put(ctx, "2026/09/abc.png", strings.NewReader("first")))
	require.NoError(t, disk.Put(ctx, "2026/09/abc.png", strings.NewReader("second")))

	rc, err := disk.Open(ctx, "2026/09/abc.png")
	require.NoError(t, err)
	body, err := io.ReadAll(rc)
	require.NoError(t, err)
	require.NoError(t, rc.Close())
	assert.Equal(t, "second", string(body))

	entries, err := os.ReadDir(filepath.Join(root, "2026", "09"))
	require.NoError(t, err)
	assert.Len(t, entries, 1, "临时文件已经 rename，不留残余")

	require.NoError(t, disk.Delete(ctx, "2026/09/abc.png"))
	_, err = disk.Open(ctx, "2026/09/abc.png")
	assert.ErrorIs(t, err, storage.ErrNotFound)
	assert.NoError(t, disk.Delete(ctx, "2026/09/abc.png"), "删除不存在的文件返回 nil")
}

func TestDiskRejectsKeysOutsideRoot(t *testing.T) {
	disk, err := storage.NewDisk(t.TempDir())
	require.NoError(t, err)
	ctx := context.Background()

	for _, key := range []string{"", "../escape.png", "/etc/passwd", "2026/../../x.png"} {
		assert.Error(t, disk.Put(ctx, key, strings.NewReader("x")), key)
		_, err := disk.Open(ctx, key)
		assert.Error(t, err, key)
		assert.NotErrorIs(t, err, storage.ErrNotFound, key)
	}
}
