package logx_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/logx"
)

func TestInfoLevelDropsDebugAndWritesJSON(t *testing.T) {
	var buf bytes.Buffer
	log := logx.New("info", &buf)

	log.Debug("hidden")
	log.Info("visible", "request_id", "req-1")

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	require.Len(t, lines, 1)
	var entry map[string]any
	require.NoError(t, json.Unmarshal(lines[0], &entry))
	assert.Equal(t, "visible", entry["msg"])
	assert.Equal(t, "req-1", entry["request_id"])
}

func TestDebugLevelWritesDebug(t *testing.T) {
	var buf bytes.Buffer
	logx.New("debug", &buf).Debug("shown")

	assert.Contains(t, buf.String(), `"msg":"shown"`)
}

func TestUnknownLevelFallsBackToInfo(t *testing.T) {
	var buf bytes.Buffer
	log := logx.New("verbose", &buf)

	log.Debug("hidden")
	log.Info("shown")

	assert.NotContains(t, buf.String(), "hidden")
	assert.Contains(t, buf.String(), "shown")
}
