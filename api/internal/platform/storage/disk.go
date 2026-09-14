package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Disk 把文件存在本地目录（WERUN_FILES_DIR）下。
type Disk struct {
	root string
}

var _ Store = (*Disk)(nil)

// NewDisk 在目录不存在时创建它。
func NewDisk(root string) (*Disk, error) {
	if root == "" {
		return nil, errors.New("storage: root directory is empty")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("storage: create root %s: %w", root, err)
	}
	return &Disk{root: root}, nil
}

// path 把 key 映射到根目录下的路径；拒绝绝对路径与跳出根目录的 key。
func (d *Disk) path(key string) (string, error) {
	local := filepath.FromSlash(key)
	if key == "" || !filepath.IsLocal(local) {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(d.root, local), nil
}

// Put 先写同目录的临时文件再 rename，读者不会看到写了一半的文件。
func (d *Disk) Put(ctx context.Context, key string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := d.path(key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("storage: create dir for %s: %w", key, err)
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return fmt.Errorf("storage: create temp file for %s: %w", key, err)
	}
	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storage: write %s: %w", key, err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storage: close %s: %w", key, err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("storage: rename %s: %w", key, err)
	}
	return nil
}

// Open 打开文件；不存在时返回 ErrNotFound。
func (d *Disk) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: open %s: %w", key, err)
	}
	return f, nil
}

// Delete 删除文件；不存在时返回 nil。
func (d *Disk) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("storage: delete %s: %w", key, err)
	}
	return nil
}
