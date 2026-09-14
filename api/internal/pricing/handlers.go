package pricing

import (
	"context"
	"math"
	"net/http"

	"werun/api/internal/httpapi/apigen"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// Handlers 实现 apigen.StrictServerInterface 中价格档与优惠码相关的操作。
type Handlers struct {
	svc *Service
}

// NewHandlers 创建 handler。
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

func (h *Handlers) AdminListPriceRules(ctx context.Context, req apigen.AdminListPriceRulesRequestObject) (apigen.AdminListPriceRulesResponseObject, error) {
	rules, err := h.svc.ListPriceRules(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	items := make([]apigen.PriceRule, 0, len(rules))
	for _, r := range rules {
		items = append(items, toAPIPriceRule(r))
	}
	return apigen.AdminListPriceRules200JSONResponse{Items: items}, nil
}

func (h *Handlers) AdminCreatePriceRule(ctx context.Context, req apigen.AdminCreatePriceRuleRequestObject) (apigen.AdminCreatePriceRuleResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in, err := priceRuleInputFromAPI(*req.Body)
	if err != nil {
		return nil, err
	}
	rule, err := h.svc.CreatePriceRule(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminCreatePriceRule201JSONResponse(toAPIPriceRule(rule)), nil
}

func (h *Handlers) AdminUpdatePriceRule(ctx context.Context, req apigen.AdminUpdatePriceRuleRequestObject) (apigen.AdminUpdatePriceRuleResponseObject, error) {
	actor, ok := iam.StaffFrom(ctx)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, apperr.CodeUnauthenticated)
	}
	if req.Body == nil {
		return nil, apperr.New(http.StatusBadRequest, apperr.CodeBadRequest)
	}
	in, err := priceRuleInputFromAPI(*req.Body)
	if err != nil {
		return nil, err
	}
	rule, err := h.svc.UpdatePriceRule(ctx, actor, req.Id, in)
	if err != nil {
		return nil, err
	}
	return apigen.AdminUpdatePriceRule200JSONResponse(toAPIPriceRule(rule)), nil
}

func priceRuleInputFromAPI(b apigen.PriceRuleInput) (PriceRuleInput, error) {
	var sortOrder int16
	if b.SortOrder != nil {
		if *b.SortOrder < 0 || *b.SortOrder > math.MaxInt16 {
			return PriceRuleInput{}, validationError().WithField("sortOrder", "field.invalid", nil)
		}
		sortOrder = int16(*b.SortOrder)
	}
	return PriceRuleInput{
		Name:         textFromAPI(b.Name),
		Audience:     string(b.Audience),
		PriceCents:   b.PriceCents,
		Quota:        b.Quota,
		SaleStartsAt: b.SaleStartsAt,
		SaleEndsAt:   b.SaleEndsAt,
		SortOrder:    sortOrder,
		CategoryIDs:  b.CategoryIds,
	}, nil
}

func toAPIPriceRule(r PriceRule) apigen.PriceRule {
	return apigen.PriceRule{
		Id:            r.ID,
		EventId:       r.EventID,
		Name:          textToAPI(r.Input.Name),
		Audience:      apigen.PriceAudience(r.Input.Audience),
		PriceCents:    r.Input.PriceCents,
		Currency:      "USD",
		Quota:         r.Input.Quota,
		SaleStartsAt:  r.Input.SaleStartsAt,
		SaleEndsAt:    r.Input.SaleEndsAt,
		SortOrder:     int32(r.Input.SortOrder),
		CategoryIds:   r.Input.CategoryIDs,
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}
}

func textToAPI(t i18n.Text) apigen.LocalizedText {
	pick := func(l i18n.Lang) *string {
		v, ok := t[l]
		if !ok {
			return nil
		}
		return &v
	}
	return apigen.LocalizedText{Zh: pick(i18n.ZH), En: pick(i18n.EN), Km: pick(i18n.KM)}
}

func textFromAPI(l apigen.LocalizedText) i18n.Text {
	t := i18n.Text{}
	if l.Zh != nil {
		t[i18n.ZH] = *l.Zh
	}
	if l.En != nil {
		t[i18n.EN] = *l.En
	}
	if l.Km != nil {
		t[i18n.KM] = *l.Km
	}
	return t
}
