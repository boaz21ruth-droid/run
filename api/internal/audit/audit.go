// Package audit 在调用方的事务里写 audit_logs。
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/platform/httpx"
)

// Entry 对应 audit_logs 的一行。
type Entry struct {
	ActorType   string // "USER" | "STAFF" | "SYSTEM"
	ActorID     *int64
	ActorRole   *string
	Action      string
	EntityType  string
	EntityID    int64
	EventID     *int64
	IsFinancial bool
	Summary     string
	Before      any // 非 nil 时 JSON 编码写 before_data
	After       any // 非 nil 时 JSON 编码写 after_data
	Meta        httpx.Meta
}

const insertSQL = `INSERT INTO audit_logs
	(actor_type, actor_id, actor_role, action, entity_type, entity_id, event_id,
	 is_financial, summary, before_data, after_data, request_id, ip, user_agent)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

// Record 必须传入事务：业务回滚时审计一起回滚。
func Record(ctx context.Context, tx pgx.Tx, e Entry) error {
	before, err := jsonOrNil(e.Before)
	if err != nil {
		return fmt.Errorf("audit: encode before_data for %s: %w", e.Action, err)
	}
	after, err := jsonOrNil(e.After)
	if err != nil {
		return fmt.Errorf("audit: encode after_data for %s: %w", e.Action, err)
	}
	_, err = tx.Exec(ctx, insertSQL,
		e.ActorType, e.ActorID, e.ActorRole, e.Action, e.EntityType, e.EntityID, e.EventID,
		e.IsFinancial, e.Summary, before, after,
		nilIfEmpty(e.Meta.RequestID), ipOrNil(e.Meta.IP), nilIfEmpty(e.Meta.UserAgent),
	)
	if err != nil {
		return fmt.Errorf("audit: insert %s: %w", e.Action, err)
	}
	return nil
}

func jsonOrNil(v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return string(b), nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func ipOrNil(s string) any {
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return nil
	}
	return addr
}
