package apperr_test

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"werun/api/internal/platform/apperr"
)

func TestNewAndError(t *testing.T) {
	e := apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken)

	assert.Equal(t, "EVENT_SLUG_TAKEN", e.Code)
	assert.Equal(t, http.StatusConflict, e.Status)
	assert.Equal(t, "EVENT_SLUG_TAKEN", e.Error())
}

func TestWithFieldReturnsCopy(t *testing.T) {
	base := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)

	withSlug := base.WithField("slug", "field.required", nil)
	withBoth := withSlug.WithField("city", "field.too_long", map[string]any{"max": 80})

	assert.Empty(t, base.Fields)
	assert.Len(t, withSlug.Fields, 1)
	assert.Len(t, withBoth.Fields, 2)
	assert.Equal(t, apperr.FieldError{Key: "field.too_long", Params: map[string]any{"max": 80}}, withBoth.Fields["city"])
}

func TestWithParamsReturnsCopy(t *testing.T) {
	base := apperr.New(http.StatusUnprocessableEntity, apperr.CodeEventCategoryIncomplete)

	withParams := base.WithParams(map[string]any{"missing": "cutoffAt"})

	assert.Nil(t, base.Params)
	assert.Equal(t, "cutoffAt", withParams.Params["missing"])
}

func TestWrapKeepsCauseAndDoesNotMutate(t *testing.T) {
	cause := errors.New("duplicate key")
	base := apperr.New(http.StatusConflict, apperr.CodeEventSlugTaken)

	wrapped := base.Wrap(cause)

	assert.Nil(t, base.Err)
	assert.ErrorIs(t, wrapped, cause)
	assert.Equal(t, "EVENT_SLUG_TAKEN: duplicate key", wrapped.Error())
}

func TestAsFindsErrorThroughWrapping(t *testing.T) {
	inner := apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	err := fmt.Errorf("load event: %w", inner)

	got, ok := apperr.As(err)

	require.True(t, ok)
	assert.Same(t, inner, got)

	_, ok = apperr.As(errors.New("plain"))
	assert.False(t, ok)
}

func TestAllCodesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range apperr.AllCodes {
		assert.False(t, seen[c], "duplicate code %s", c)
		seen[c] = true
	}
	assert.Len(t, apperr.AllCodes, 21)
	assert.Contains(t, apperr.AllCodes, apperr.CodeFileTooLarge)
	assert.Contains(t, apperr.AllCodes, apperr.CodeFileTypeNotAllowed)
}
