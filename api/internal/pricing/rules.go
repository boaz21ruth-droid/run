package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"werun/api/internal/audit"
	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/db"
	"werun/api/internal/platform/i18n"
	"werun/api/internal/pricing/store"
)

const priceRuleNameMaxLen = 60

// ValidatePriceRule 校验价格档输入，一次返回全部字段错误。组别归属在事务里另行检查。
func ValidatePriceRule(in PriceRuleInput) error {
	verr := validationError()
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}

	for _, l := range requiredLangs {
		name := strings.TrimSpace(in.Name[l])
		switch {
		case name == "":
			add("name."+string(l), "field.required", nil)
		case utf8.RuneCountInString(name) > priceRuleNameMaxLen:
			add("name."+string(l), "field.too_long", map[string]any{"max": priceRuleNameMaxLen})
		}
	}
	if in.Audience != AudienceAll && in.Audience != AudienceLocal {
		add("audience", "field.invalid", nil)
	}
	if in.PriceCents < 0 {
		add("priceCents", "field.invalid", nil)
	}
	if in.Quota != nil && *in.Quota < 0 {
		add("quota", "field.invalid", nil)
	}
	if in.SaleStartsAt != nil && in.SaleEndsAt != nil && !in.SaleEndsAt.After(*in.SaleStartsAt) {
		add("saleEndsAt", "field.ends_before_starts", nil)
	}
	if in.SortOrder < 0 {
		add("sortOrder", "field.invalid", nil)
	}
	if len(in.CategoryIDs) == 0 {
		add("categoryIds", "field.required", nil)
	}

	if failed {
		return verr
	}
	return nil
}

// ListPriceRules 返回赛事的全部价格档（按排序、id）；赛事不存在返回 EVENT_NOT_FOUND。
func (s *Service) ListPriceRules(ctx context.Context, eventID int64) ([]PriceRule, error) {
	q := store.New(s.pool)
	if err := requireEvent(ctx, q, eventID); err != nil {
		return nil, err
	}
	rows, err := q.ListPriceRulesByEvent(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("list price rules of event %d: %w", eventID, err)
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	links, err := categoryIDsByRule(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	out := make([]PriceRule, 0, len(rows))
	for _, r := range rows {
		rule, err := priceRuleFromRow(r, links[r.ID])
		if err != nil {
			return nil, err
		}
		out = append(out, rule)
	}
	return out, nil
}

// CreatePriceRule 新建价格档并关联组别，写审计 price_rule.create。
func (s *Service) CreatePriceRule(ctx context.Context, actor iam.Staff, eventID int64, in PriceRuleInput) (PriceRule, error) {
	if err := ValidatePriceRule(in); err != nil {
		return PriceRule{}, err
	}
	in.CategoryIDs = normalizeIDs(in.CategoryIDs)
	name, err := json.Marshal(in.Name)
	if err != nil {
		return PriceRule{}, fmt.Errorf("encode price rule name: %w", err)
	}

	var out PriceRule
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if err := requireEvent(ctx, q, eventID); err != nil {
			return err
		}
		if err := requireCategoriesOf(ctx, q, eventID, in.CategoryIDs); err != nil {
			return err
		}
		row, err := q.InsertPriceRule(ctx, store.InsertPriceRuleParams{
			EventID:      eventID,
			Name:         name,
			Audience:     in.Audience,
			PriceCents:   in.PriceCents,
			Quota:        in.Quota,
			SaleStartsAt: in.SaleStartsAt,
			SaleEndsAt:   in.SaleEndsAt,
			SortOrder:    in.SortOrder,
		})
		if err != nil {
			return fmt.Errorf("insert price rule: %w", err)
		}
		if err := insertCategoryLinks(ctx, q, row.ID, in.CategoryIDs); err != nil {
			return err
		}
		rule, err := priceRuleFromRow(row, in.CategoryIDs)
		if err != nil {
			return err
		}
		out = rule
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "price_rule.create", "price_rule", rule.ID, &rule.EventID,
			fmt.Sprintf("新建价格档 %d（%s，%d 分）", rule.ID, rule.Input.Audience, rule.Input.PriceCents),
			nil, priceRuleSnapshot(rule)))
	})
	if err != nil {
		return PriceRule{}, err
	}
	return out, nil
}

// UpdatePriceRule 锁定价格档后按 spec §7 的规则修改，写审计 price_rule.update。
func (s *Service) UpdatePriceRule(ctx context.Context, actor iam.Staff, id int64, in PriceRuleInput) (PriceRule, error) {
	if err := ValidatePriceRule(in); err != nil {
		return PriceRule{}, err
	}
	in.CategoryIDs = normalizeIDs(in.CategoryIDs)
	name, err := json.Marshal(in.Name)
	if err != nil {
		return PriceRule{}, fmt.Errorf("encode price rule name: %w", err)
	}

	var out PriceRule
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		row, err := q.GetPriceRuleForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(http.StatusNotFound, apperr.CodeNotFound)
		}
		if err != nil {
			return fmt.Errorf("lock price rule %d: %w", id, err)
		}
		links, err := categoryIDsByRule(ctx, q, []int64{id})
		if err != nil {
			return err
		}
		before, err := priceRuleFromRow(row, links[id])
		if err != nil {
			return err
		}
		if err := requireCategoriesOf(ctx, q, row.EventID, in.CategoryIDs); err != nil {
			return err
		}

		taken := row.UsedCount + row.ReservedCount
		categoriesChanged := !slices.Equal(before.Input.CategoryIDs, in.CategoryIDs)
		if taken > 0 && (in.PriceCents != row.PriceCents || in.Audience != row.Audience || categoriesChanged) {
			return apperr.New(http.StatusConflict, apperr.CodePriceRuleLocked)
		}
		if in.Quota != nil && *in.Quota < taken {
			return validationError().WithField("quota", "field.quota_below_taken", map[string]any{"min": taken})
		}

		updatedRow, err := q.UpdatePriceRule(ctx, store.UpdatePriceRuleParams{
			Name:         name,
			Audience:     in.Audience,
			PriceCents:   in.PriceCents,
			Quota:        in.Quota,
			SaleStartsAt: in.SaleStartsAt,
			SaleEndsAt:   in.SaleEndsAt,
			SortOrder:    in.SortOrder,
			ID:           id,
		})
		if err != nil {
			return fmt.Errorf("update price rule %d: %w", id, err)
		}
		if categoriesChanged {
			if err := q.DeleteCategoryLinksByRule(ctx, id); err != nil {
				return fmt.Errorf("delete category links of price rule %d: %w", id, err)
			}
			if err := insertCategoryLinks(ctx, q, id, in.CategoryIDs); err != nil {
				return err
			}
		}
		after, err := priceRuleFromRow(updatedRow, in.CategoryIDs)
		if err != nil {
			return err
		}
		out = after
		return audit.Record(ctx, tx, staffEntry(ctx, actor, "price_rule.update", "price_rule", after.ID, &after.EventID,
			fmt.Sprintf("修改价格档 %d", after.ID), priceRuleSnapshot(before), priceRuleSnapshot(after)))
	})
	if err != nil {
		return PriceRule{}, err
	}
	return out, nil
}

func requireCategoriesOf(ctx context.Context, q *store.Queries, eventID int64, categoryIDs []int64) error {
	own, err := q.ListCategoryIDsOfEvent(ctx, eventID)
	if err != nil {
		return fmt.Errorf("list categories of event %d: %w", eventID, err)
	}
	for _, id := range categoryIDs {
		if !slices.Contains(own, id) {
			return validationError().WithField("categoryIds", "field.invalid", nil)
		}
	}
	return nil
}

func categoryIDsByRule(ctx context.Context, q *store.Queries, ruleIDs []int64) (map[int64][]int64, error) {
	out := make(map[int64][]int64, len(ruleIDs))
	if len(ruleIDs) == 0 {
		return out, nil
	}
	rows, err := q.ListCategoryLinksByRuleIDs(ctx, ruleIDs)
	if err != nil {
		return nil, fmt.Errorf("list category links: %w", err)
	}
	for _, r := range rows {
		out[r.PriceRuleID] = append(out[r.PriceRuleID], r.CategoryID)
	}
	return out, nil
}

func insertCategoryLinks(ctx context.Context, q *store.Queries, ruleID int64, categoryIDs []int64) error {
	for _, categoryID := range categoryIDs {
		if err := q.InsertCategoryLink(ctx, store.InsertCategoryLinkParams{CategoryID: categoryID, PriceRuleID: ruleID}); err != nil {
			return fmt.Errorf("link category %d to price rule %d: %w", categoryID, ruleID, err)
		}
	}
	return nil
}

func priceRuleFromRow(r store.PriceRule, categoryIDs []int64) (PriceRule, error) {
	var name i18n.Text
	if err := json.Unmarshal(r.Name, &name); err != nil {
		return PriceRule{}, fmt.Errorf("decode name of price rule %d: %w", r.ID, err)
	}
	if categoryIDs == nil {
		categoryIDs = []int64{}
	}
	return PriceRule{
		ID:      r.ID,
		EventID: r.EventID,
		Input: PriceRuleInput{
			Name:         name,
			Audience:     r.Audience,
			PriceCents:   r.PriceCents,
			Quota:        r.Quota,
			SaleStartsAt: r.SaleStartsAt,
			SaleEndsAt:   r.SaleEndsAt,
			SortOrder:    r.SortOrder,
			CategoryIDs:  categoryIDs,
		},
		UsedCount:     r.UsedCount,
		ReservedCount: r.ReservedCount,
	}, nil
}

func priceRuleSnapshot(r PriceRule) map[string]any {
	return map[string]any{
		"name":         r.Input.Name,
		"audience":     r.Input.Audience,
		"priceCents":   r.Input.PriceCents,
		"quota":        r.Input.Quota,
		"saleStartsAt": r.Input.SaleStartsAt,
		"saleEndsAt":   r.Input.SaleEndsAt,
		"sortOrder":    r.Input.SortOrder,
		"categoryIds":  r.Input.CategoryIDs,
	}
}
