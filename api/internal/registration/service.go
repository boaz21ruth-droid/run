package registration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/notify"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing"
	"werun/api/internal/runner"
)

// Service 是报名订单模块的业务入口。
type Service struct {
	pool     *pgxpool.Pool
	runners  *runner.Service
	prices   *pricing.Service
	notifier *notify.Service
	now      func() time.Time
}

// NewService 创建报名订单服务。
func NewService(pool *pgxpool.Pool, runners *runner.Service, prices *pricing.Service, notifier *notify.Service, now func() time.Time) *Service {
	return &Service{pool: pool, runners: runners, prices: prices, notifier: notifier, now: now}
}

// fieldErrors 收集字段错误，一次返回。
type fieldErrors struct {
	err    *apperr.Error
	failed bool
}

func newFieldErrors() *fieldErrors {
	return &fieldErrors{err: apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)}
}

func (f *fieldErrors) add(field, key string, params map[string]any) {
	f.err = f.err.WithField(field, key, params)
	f.failed = true
}

// merge 把 VALIDATION_FAILED 的字段并入；nil 返回 nil；其它错误原样返回给调用方。
func (f *fieldErrors) merge(err error) error {
	if err == nil {
		return nil
	}
	ae, ok := apperr.As(err)
	if !ok || ae.Code != apperr.CodeValidation {
		return err
	}
	for field, fe := range ae.Fields {
		f.add(field, fe.Key, fe.Params)
	}
	f.failed = true
	return nil
}

func (f *fieldErrors) result() error {
	if f.failed {
		return f.err
	}
	return nil
}

// withSavepoint 在保存点里执行 fn：唯一约束冲突等错误只回滚到保存点，外层事务仍可继续（供 idgen.Retry 重试）。
func withSavepoint(ctx context.Context, tx pgx.Tx, fn func(sp pgx.Tx) error) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin savepoint: %w", err)
	}
	if err := fn(sp); err != nil {
		if rbErr := sp.Rollback(ctx); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
			return errors.Join(err, fmt.Errorf("rollback savepoint: %w", rbErr))
		}
		return err
	}
	if err := sp.Commit(ctx); err != nil {
		return fmt.Errorf("release savepoint: %w", err)
	}
	return nil
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func decodeText(raw []byte, what string) (i18n.Text, error) {
	var t i18n.Text
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("decode %s: %w", what, err)
	}
	return t, nil
}

func runnerAudit(u runner.User, action string, orderID, eventID int64, summary string, after any, meta httpx.Meta) audit.Entry {
	actorID := u.ID
	evID := eventID
	return audit.Entry{
		ActorType:   "USER",
		ActorID:     &actorID,
		Action:      action,
		EntityType:  "reg_order",
		EntityID:    orderID,
		EventID:     &evID,
		IsFinancial: true,
		Summary:     summary,
		After:       after,
		Meta:        meta,
	}
}
