package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func runCmd(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRunWithoutArgsPrintsUsage(t *testing.T) {
	code, _, stderr := runCmd()

	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, "Commands:")
}

func TestRunUnknownCommand(t *testing.T) {
	code, _, stderr := runCmd("fly")

	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, `unknown command "fly"`)
}

func TestMigrateRejectsUnknownSubcommandBeforeConnecting(t *testing.T) {
	code, _, stderr := runCmd("migrate", "sideways")

	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, "usage: werun migrate up|down|status")
}

func TestHealthcheck(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ok.Close()
	unavailable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unavailable.Close()

	code, stdout, _ := runCmd("healthcheck", "--url", ok.URL)
	assert.Equal(t, 0, code)
	assert.Equal(t, "ok\n", stdout)

	code, _, stderr := runCmd("healthcheck", "--url", unavailable.URL)
	assert.Equal(t, 1, code)
	assert.Contains(t, stderr, "status 503")

	code, _, _ = runCmd("healthcheck", "--url", "http://127.0.0.1:1/api/readyz")
	assert.Equal(t, 1, code)
}
