// Package logx 创建结构化 JSON 日志器。
package logx

import (
	"io"
	"log/slog"
	"strings"
)

// New 返回写入 w 的 JSON 日志器。level 可取 debug、info、warn、error，其他值按 info 处理。
func New(level string, w io.Writer) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl}))
}
