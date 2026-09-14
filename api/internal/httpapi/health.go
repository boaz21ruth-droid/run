package httpapi

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"werun/api/internal/httpapi/apigen"
)

// HealthHandlers 实现 getHealthz / getReadyz。
type HealthHandlers struct {
	pool *pgxpool.Pool
}

func NewHealthHandlers(pool *pgxpool.Pool) *HealthHandlers {
	return &HealthHandlers{pool: pool}
}

func (h *HealthHandlers) GetHealthz(ctx context.Context, _ apigen.GetHealthzRequestObject) (apigen.GetHealthzResponseObject, error) {
	return apigen.GetHealthz200JSONResponse{Status: "ok"}, nil
}

func (h *HealthHandlers) GetReadyz(ctx context.Context, _ apigen.GetReadyzRequestObject) (apigen.GetReadyzResponseObject, error) {
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := h.pool.Ping(pingCtx); err != nil {
		return apigen.GetReadyz503JSONResponse{Status: "unavailable"}, nil
	}
	return apigen.GetReadyz200JSONResponse{Status: "ok"}, nil
}
