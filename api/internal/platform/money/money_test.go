package money_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"werun/api/internal/platform/money"
)

func TestCentsString(t *testing.T) {
	cases := map[money.Cents]string{
		0:      "$0.00",
		5:      "$0.05",
		2193:   "$21.93",
		100000: "$1000.00",
		-500:   "-$5.00",
		-7:     "-$0.07",
	}
	for cents, want := range cases {
		assert.Equal(t, want, cents.String(), "cents=%d", int64(cents))
	}
}
