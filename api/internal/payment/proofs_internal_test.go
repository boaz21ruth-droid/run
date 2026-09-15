package payment

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeTxnRefRemovesAllWhitespaceAndUppercases(t *testing.T) {
	require.Equal(t, "ABA778899", normalizeTxnRef(" aba 7788\t99\n"))
	require.Equal(t, "AB-12", normalizeTxnRef("ab-12"))
	require.Equal(t, "ABCD", normalizeTxnRef("　ab　cd"))
	require.Empty(t, normalizeTxnRef(""))
}
