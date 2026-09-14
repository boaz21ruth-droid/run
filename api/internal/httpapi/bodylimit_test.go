package httpapi

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBodyLimitFor(t *testing.T) {
	cases := map[string]int64{
		"/api/app/orders/WR7K3M9Q2A/proofs":   6 << 20,
		"/api/admin/payment-accounts":         6 << 20,
		"/api/admin/payment-accounts/12":      6 << 20,
		"/api/app/orders/WR7K3M9Q2A/proofs/1": 1 << 20,
		"/api/app/orders//proofs":             1 << 20,
		"/api/admin/payment-accounts/abc":     1 << 20,
		"/api/admin/payment-accounts/12/qr":   1 << 20,
		"/api/admin/events":                   1 << 20,
		"/api/app/orders":                     1 << 20,
		"/prefix/api/admin/payment-accounts":  1 << 20,
	}
	for path, want := range cases {
		assert.Equal(t, want, bodyLimitFor(path), path)
	}
}
