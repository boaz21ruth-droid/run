package apperr_test

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
)

func TestFromPG(t *testing.T) {
	apperr.RegisterConstraint("test_things_slug_key", func() *apperr.Error {
		return apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken).WithField("slug", "field.invalid", nil)
	})

	t.Run("nil stays nil", func(t *testing.T) {
		assert.NoError(t, apperr.FromPG(nil))
	})

	t.Run("non pg error is returned unchanged", func(t *testing.T) {
		plain := errors.New("plain")
		assert.Same(t, plain, apperr.FromPG(plain))
	})

	t.Run("unregistered constraint is returned unchanged", func(t *testing.T) {
		pgErr := &pgconn.PgError{Code: "23505", ConstraintName: "other_key"}
		assert.Same(t, pgErr, apperr.FromPG(pgErr))
	})

	t.Run("registered constraint maps to business error", func(t *testing.T) {
		pgErr := &pgconn.PgError{Code: "23505", ConstraintName: "test_things_slug_key"}

		err := apperr.FromPG(fmt.Errorf("insert: %w", pgErr))

		ae, ok := apperr.As(err)
		require.True(t, ok)
		assert.Equal(t, apperr.CodeEventSlugTaken, ae.Code)
		assert.Contains(t, ae.Fields, "slug")
		var gotPG *pgconn.PgError
		assert.True(t, errors.As(err, &gotPG))
	})
}
