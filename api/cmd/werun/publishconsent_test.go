package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/runner"
)

const consentItemsArg = `[{"k":"rules","t":"我已阅读并遵守赛事规则","d":"包括关门时间"},{"k":"health","t":"我的身体状况适合参赛"}]`

func consentArgs(file string, extra ...string) []string {
	args := []string{
		"--purpose", "REGISTRATION",
		"--version", "REG-v1",
		"--lang", "zh",
		"--effective-date", "2026-09-01",
		"--file", file,
		"--items", consentItemsArg,
	}
	return append(args, extra...)
}

func TestParsePublishConsentArgsReadsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "consent.md")
	require.NoError(t, os.WriteFile(path, []byte("# 报名同意书\n\n正文\n"), 0o600))

	in, err := parsePublishConsentArgs(consentArgs(path), strings.NewReader("ignored"), io.Discard)

	require.NoError(t, err)
	assert.Equal(t, runner.PublishConsentInput{
		Purpose:       "REGISTRATION",
		Version:       "REG-v1",
		Lang:          "zh",
		EffectiveDate: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		FullText:      "# 报名同意书\n\n正文\n",
		Items: []runner.ConsentItem{
			{Key: "rules", Title: "我已阅读并遵守赛事规则", Description: "包括关门时间"},
			{Key: "health", Title: "我的身体状况适合参赛"},
		},
	}, in)
}

func TestParsePublishConsentArgsReadsStdin(t *testing.T) {
	in, err := parsePublishConsentArgs(consentArgs("-"), strings.NewReader("Consent body from stdin\n"), io.Discard)

	require.NoError(t, err)
	assert.Equal(t, "Consent body from stdin\n", in.FullText)
}

func TestParsePublishConsentArgsRejectsBadInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "consent.md")
	require.NoError(t, os.WriteFile(path, []byte("body"), 0o600))
	replace := func(flag, value string) []string {
		args := consentArgs(path)
		for i := range args {
			if args[i] == flag {
				args[i+1] = value
			}
		}
		return args
	}
	cases := map[string]struct {
		args []string
		want string
	}{
		"missing purpose":    {replace("--purpose", ""), "缺少 --purpose"},
		"missing version":    {replace("--version", ""), "缺少 --version"},
		"missing file":       {replace("--file", ""), "缺少 --file"},
		"missing items":      {replace("--items", ""), "缺少 --items"},
		"bad date":           {replace("--effective-date", "2026/09/01"), "--effective-date"},
		"items not an array": {replace("--items", `{"k":"rules","t":"x"}`), "--items"},
		"items unknown key":  {replace("--items", `[{"key":"rules","title":"x"}]`), "--items"},
		"items trailing":     {replace("--items", `[] []`), "--items"},
		"file not found":     {replace("--file", filepath.Join(t.TempDir(), "missing.md")), "读取同意书正文失败"},
		"extra argument":     {consentArgs(path, "leftover"), "多余的参数"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parsePublishConsentArgs(tc.args, strings.NewReader(""), io.Discard)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}

func TestPublishConsentCommandFailsBeforeConnecting(t *testing.T) {
	code, stdout, stderr := runCmd("publish-consent", "--version", "REG-v1")

	assert.Equal(t, 1, code)
	assert.Empty(t, stdout)
	assert.Contains(t, stderr, "publish-consent: 缺少 --purpose")
}
