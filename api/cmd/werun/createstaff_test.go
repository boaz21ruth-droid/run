package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/iam"
)

func TestReadPasswordLine(t *testing.T) {
	for input, want := range map[string]string{
		"correct-horse-1\n":   "correct-horse-1",
		"correct-horse-1\r\n": "correct-horse-1",
		"correct-horse-1":     "correct-horse-1",
		"first\nsecond\n":     "first",
	} {
		got, err := readPasswordLine(strings.NewReader(input))
		require.NoError(t, err, input)
		assert.Equal(t, want, got, input)
	}
}

func TestReadPasswordLineEmpty(t *testing.T) {
	for _, input := range []string{"", "\n", "\r\n"} {
		_, err := readPasswordLine(strings.NewReader(input))
		assert.Error(t, err, "%q", input)
	}
}

func TestRoleListContainsAllRoles(t *testing.T) {
	list := roleList()
	for _, r := range iam.AllRoles {
		assert.Contains(t, list, string(r))
	}
}
