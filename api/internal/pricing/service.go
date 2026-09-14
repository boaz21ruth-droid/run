package pricing

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing/store"
)

var requiredLangs = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}

// Service 是价格与优惠模块的业务入口。
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService 创建服务；now 供算价与优惠码有效期判断使用（测试注入固定时间）。
func NewService(pool *pgxpool.Pool, now func() time.Time) *Service {
	return &Service{pool: pool, now: now}
}

func requireEvent(ctx context.Context, q *store.Queries, eventID int64) error {
	exists, err := q.EventExists(ctx, eventID)
	if err != nil {
		return fmt.Errorf("check event %d: %w", eventID, err)
	}
	if !exists {
		return apperr.New(http.StatusNotFound, apperr.CodeEventNotFound)
	}
	return nil
}

// normalizeIDs 返回去重、升序的副本。
func normalizeIDs(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return slices.Compact(out)
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

func staffEntry(ctx context.Context, actor iam.Staff, action, entityType string, entityID int64, eventID *int64, summary string, before, after any) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:  "STAFF",
		ActorID:    &actorID,
		ActorRole:  &role,
		Action:     action,
		EntityType: entityType,
		EntityID:   entityID,
		EventID:    eventID,
		Summary:    summary,
		Before:     before,
		After:      after,
		Meta:       httpx.MetaOf(ctx),
	}
}
