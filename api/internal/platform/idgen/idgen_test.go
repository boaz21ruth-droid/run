package idgen_test

import (
	"errors"
	"fmt"
	"regexp"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/idgen"
)

func TestCodeFormat(t *testing.T) {
	pattern := regexp.MustCompile(`^WR[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$`)
	seen := map[string]bool{}
	for range 200 {
		code := idgen.Code(idgen.PrefixOrder)
		require.Regexp(t, pattern, code)
		seen[code] = true
	}
	assert.Greater(t, len(seen), 195, "40 位随机数，200 次几乎不可能大量重复")
	assert.Regexp(t, `^FS[0-9A-Z]{8}$`, idgen.Code(idgen.PrefixFreeSignup))
	assert.Equal(t, []string{"WR", "PF", "RG", "FS", "EX"},
		[]string{idgen.PrefixOrder, idgen.PrefixProof, idgen.PrefixRegistration, idgen.PrefixFreeSignup, idgen.PrefixException})
}

func TestTicketCodeFormat(t *testing.T) {
	code := idgen.TicketCode()
	assert.Regexp(t, `^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$`, code)
	assert.NotEqual(t, code, idgen.TicketCode())
}

func uniqueViolation(constraint string) error {
	return fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505", ConstraintName: constraint})
}

func TestRetryRetriesMatchingUniqueViolation(t *testing.T) {
	calls := 0
	err := idgen.Retry("reg_orders_order_no_key", func() error {
		calls++
		if calls < 3 {
			return uniqueViolation("reg_orders_order_no_key")
		}
		return nil
	})

	require.NoError(t, err)
	assert.Equal(t, 3, calls)
}

func TestRetryGivesUpAfterThreeAttempts(t *testing.T) {
	calls := 0
	err := idgen.Retry("reg_orders_order_no_key", func() error {
		calls++
		return uniqueViolation("reg_orders_order_no_key")
	})

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	assert.Equal(t, "reg_orders_order_no_key", pgErr.ConstraintName)
	assert.Equal(t, 3, calls)
}

func TestRetryReturnsOtherErrorsImmediately(t *testing.T) {
	for name, returned := range map[string]error{
		"其他约束":  uniqueViolation("payment_proofs_txn_ref_uniq"),
		"非唯一冲突": &pgconn.PgError{Code: "23514", ConstraintName: "reg_orders_order_no_key"},
		"普通错误":  errors.New("boom"),
	} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			err := idgen.Retry("reg_orders_order_no_key", func() error {
				calls++
				return returned
			})
			assert.ErrorIs(t, err, returned)
			assert.Equal(t, 1, calls)
		})
	}
}
