package event

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

const slugMaxLen = 60

var (
	slugPattern         = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	categoryCodePattern = regexp.MustCompile(`^[0-9A-Z]{1,10}$`)
	requiredLangs       = []i18n.Lang{i18n.ZH, i18n.EN, i18n.KM}
)

// ValidateCreate 校验新建赛事的输入，一次返回全部字段错误。
func ValidateCreate(in CreateInput) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	failed := false
	add := func(field, key string, params map[string]any) {
		verr = verr.WithField(field, key, params)
		failed = true
	}

	switch {
	case in.Slug == "":
		add("slug", "field.required", nil)
	case len(in.Slug) > slugMaxLen:
		add("slug", "field.too_long", map[string]any{"max": slugMaxLen})
	case !slugPattern.MatchString(in.Slug):
		add("slug", "field.slug_format", nil)
	}
	if in.EventType != TypeRace && in.EventType != TypeFreeActivity {
		add("eventType", "field.invalid", nil)
	}
	if in.OrganizerType != OrganizerOfficial && in.OrganizerType != OrganizerPartner {
		add("organizerType", "field.invalid", nil)
	}
	for _, l := range requiredLangs {
		if strings.TrimSpace(in.Name[l]) == "" {
			add("name."+string(l), "field.required", nil)
		}
	}
	if strings.TrimSpace(in.City) == "" {
		add("city", "field.required", nil)
	}
	if in.RaceDate.IsZero() {
		add("raceDate", "field.required", nil)
	}

	seenCodes := make(map[string]bool, len(in.Categories))
	for i, c := range in.Categories {
		prefix := fmt.Sprintf("categories[%d].", i)
		switch {
		case !categoryCodePattern.MatchString(c.Code):
			add(prefix+"code", "field.category_code_format", nil)
		case seenCodes[c.Code]:
			add(prefix+"code", apperr.CodeEventCategoryCodeTaken, nil)
		}
		seenCodes[c.Code] = true
		for _, l := range requiredLangs {
			if strings.TrimSpace(c.Name[l]) == "" {
				add(prefix+"name."+string(l), "field.required", nil)
			}
		}
		if c.DistanceM <= 0 {
			add(prefix+"distanceM", "field.must_be_positive", nil)
		}
		if c.Capacity < 1 {
			add(prefix+"capacity", "field.must_be_positive", nil)
		}
		if c.StartAt != nil && c.CutoffAt != nil && !c.CutoffAt.After(*c.StartAt) {
			add(prefix+"cutoffAt", "field.cutoff_before_start", nil)
		}
	}

	if failed {
		return verr
	}
	return nil
}

// ValidateForPublish 是发布前校验（样例版，spec §7.2）。
// 完整规则里的"每个组别必须配置价格档"在报名迭代中加入。
func ValidateForPublish(e Event) error {
	if e.Status == StatusPublished {
		return apperr.New(http.StatusConflict, apperr.CodeEventAlreadyPublished)
	}
	if len(e.Categories) == 0 {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeEventNoCategory).
			WithField("categories", apperr.CodeEventNoCategory, nil)
	}

	var problems []string
	for _, c := range e.Categories {
		var missing []string
		if c.Capacity <= 0 {
			missing = append(missing, "capacity")
		}
		if c.StartAt == nil {
			missing = append(missing, "start_at")
		}
		if c.CutoffAt == nil {
			missing = append(missing, "cutoff_at")
		}
		if c.StartAt != nil && c.CutoffAt != nil && !c.CutoffAt.After(*c.StartAt) {
			missing = append(missing, "cutoff_before_start")
		}
		if len(missing) > 0 {
			problems = append(problems, c.Code+": "+strings.Join(missing, ", "))
		}
	}
	if len(problems) > 0 {
		params := map[string]any{"missing": strings.Join(problems, "; ")}
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeEventCategoryIncomplete).
			WithParams(params).
			WithField("categories", "field.category_incomplete", params)
	}
	return nil
}

// ValidateRegistration 校验报名时间：两者都有时截止必须晚于开始。
func ValidateRegistration(in RegistrationInput) error {
	if in.OpensAt != nil && in.ClosesAt != nil && !in.ClosesAt.After(*in.OpensAt) {
		return apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation).
			WithField("closesAt", "field.ends_before_starts", nil)
	}
	return nil
}

// CheckRegistrationReady 是开放报名前的校验：赛事必须已发布；付费赛事（RACE）每个组别至少有一个
// 价格档（categoriesWithoutPriceRule 为空），且至少有一个可用于该赛事报名的启用美元收款账户。
// 免费活动忽略后两个参数。不满足时返回 REGISTRATION_NOT_READY，Params 为 missing 与 categories，
// 同时附带字段错误供前端逐条展示（错误响应体不包含 Params）。
func CheckRegistrationReady(e Event, categoriesWithoutPriceRule []string, usableAccounts int64) error {
	notReady := apperr.New(http.StatusUnprocessableEntity, apperr.CodeRegistrationNotReady)
	missing := []string{}
	categories := []string{}

	if e.Status != StatusPublished {
		missing = append(missing, MissingPublished)
		notReady = notReady.WithField("status", "field.event_not_published", nil)
	}
	if e.EventType == TypeRace {
		if len(categoriesWithoutPriceRule) > 0 {
			missing = append(missing, MissingPriceRule)
			categories = append(categories, categoriesWithoutPriceRule...)
			notReady = notReady.WithField("priceRules", "field.missing_price_rule",
				map[string]any{"categories": strings.Join(categoriesWithoutPriceRule, ", ")})
		}
		if usableAccounts == 0 {
			missing = append(missing, MissingPaymentAccount)
			notReady = notReady.WithField("paymentAccounts", "field.missing_payment_account", nil)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return notReady.WithParams(map[string]any{"missing": missing, "categories": categories})
}

const (
	maxRefundTiers    = 5
	maxPolicyDays     = 365
	maxQualifyRuleLen = 200
	maxQualifyMs      = 24 * 60 * 60 * 1000
)

// ValidateRefundPolicy 校验退改政策：最多 5 档，天数 0–365 且严格从大到小，比例 0–100 且越临近开赛不能越高。
func ValidateRefundPolicy(p RefundPolicy) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	failed := false
	add := func(field, key string) {
		verr = verr.WithField(field, key, nil)
		failed = true
	}
	if len(p.Tiers) > maxRefundTiers {
		add("tiers", "field.invalid")
	}
	for i, t := range p.Tiers {
		prefix := fmt.Sprintf("tiers[%d].", i)
		if t.Days < 0 || t.Days > maxPolicyDays {
			add(prefix+"days", "field.invalid")
		}
		if t.Percent < 0 || t.Percent > 100 {
			add(prefix+"percent", "field.invalid")
		}
		if i > 0 {
			prev := p.Tiers[i-1]
			if t.Days >= prev.Days {
				add(prefix+"days", "field.refund_tier_order")
			}
			if t.Percent > prev.Percent {
				add(prefix+"percent", "field.refund_tier_order")
			}
		}
	}
	if p.TransferDays != nil && (*p.TransferDays < 0 || *p.TransferDays > maxPolicyDays) {
		add("transferDays", "field.invalid")
	}
	if failed {
		return verr
	}
	return nil
}

// ValidateQualification 校验资格要求本身（三语说明、成绩上限）；组别之间的关系由 Service 查库校验。
func ValidateQualification(q Qualification) error {
	verr := apperr.New(http.StatusUnprocessableEntity, apperr.CodeValidation)
	failed := false
	for _, l := range requiredLangs {
		rule := strings.TrimSpace(q.Rule[l])
		switch {
		case rule == "":
			verr = verr.WithField("rule."+string(l), "field.required", nil)
			failed = true
		case len([]rune(rule)) > maxQualifyRuleLen:
			verr = verr.WithField("rule."+string(l), "field.too_long", map[string]any{"max": maxQualifyRuleLen})
			failed = true
		}
	}
	if q.MaxMs != nil && (*q.MaxMs <= 0 || *q.MaxMs > maxQualifyMs) {
		verr = verr.WithField("maxTimeMs", "field.invalid", nil)
		failed = true
	}
	if q.FallbackCategoryID <= 0 {
		verr = verr.WithField("fallbackCategoryId", "field.required", nil)
		failed = true
	}
	if failed {
		return verr
	}
	return nil
}
