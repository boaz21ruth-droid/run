package payment

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/notify"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/httpx"
	"werun/api/internal/platform/storage"
	"werun/api/internal/registration"
)

// Service 是收款模块的业务入口：收款账户、凭证上传与审核。
type Service struct {
	pool     *pgxpool.Pool
	files    storage.Store
	orders   *registration.Service
	notifier *notify.Service
	now      func() time.Time
}

// NewService 创建收款服务。orders 用于在收款事务内锁单与改订单状态，notifier 用于审核结果推送；
// 只维护收款账户的调用方两者都可以传 nil。
func NewService(pool *pgxpool.Pool, files storage.Store, orders *registration.Service, notifier *notify.Service, now func() time.Time) *Service {
	return &Service{pool: pool, files: files, orders: orders, notifier: notifier, now: now}
}

func validationError() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
}

// discardFile 在事务失败后尽力删除已写入存储的文件；失败只记日志。
func (s *Service) discardFile(ctx context.Context, key string) {
	if err := s.files.Delete(context.WithoutCancel(ctx), key); err != nil {
		slog.WarnContext(ctx, "discard uploaded file failed", "storage_key", key, "error", err)
	}
}

func staffEntry(ctx context.Context, actor iam.Staff, action string, entityID int64, eventID *int64, summary string, before, after any) audit.Entry {
	actorID := actor.ID
	role := string(actor.Role)
	return audit.Entry{
		ActorType:   "STAFF",
		ActorID:     &actorID,
		ActorRole:   &role,
		Action:      action,
		EntityType:  "payment_account",
		EntityID:    entityID,
		EventID:     eventID,
		IsFinancial: true,
		Summary:     summary,
		Before:      before,
		After:       after,
		Meta:        httpx.MetaOf(ctx),
	}
}
