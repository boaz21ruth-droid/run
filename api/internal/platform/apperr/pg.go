package apperr

import (
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgconn"
)

var (
	constraintsMu sync.RWMutex
	constraints   = map[string]func() *Error{}
)

// RegisterConstraint 把数据库约束名映射为业务错误。各模块在 init() 中注册自己的约束。
func RegisterConstraint(constraint string, build func() *Error) {
	constraintsMu.Lock()
	defer constraintsMu.Unlock()
	constraints[constraint] = build
}

// FromPG 把已注册约束触发的 PostgreSQL 错误转换为业务错误（并保留原错误）。
// 非 PostgreSQL 错误、没有约束名或约束未注册时，原样返回。
func FromPG(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName == "" {
		return err
	}
	constraintsMu.RLock()
	build, ok := constraints[pgErr.ConstraintName]
	constraintsMu.RUnlock()
	if !ok {
		return err
	}
	return build().Wrap(err)
}
