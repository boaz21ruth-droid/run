import { formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import dayjs, { type Dayjs } from "dayjs";
import { toNamePath, type LocalizedValues } from "../events/eventForm";

export interface PriceRuleFormValues {
  name: LocalizedValues;
  audience: Schemas["PriceAudience"];
  priceUsd: string;
  quota?: number | null;
  saleStartsAt?: Dayjs | null;
  saleEndsAt?: Dayjs | null;
  sortOrder?: number | null;
  categoryIds: number[];
}

/** 新建价格档的初始值：默认关联赛事全部组别 */
export function emptyPriceRule(categoryIds: number[]): PriceRuleFormValues {
  return {
    name: { zh: "", en: "", km: "" },
    audience: "ALL",
    priceUsd: "",
    quota: null,
    saleStartsAt: null,
    saleEndsAt: null,
    sortOrder: 0,
    categoryIds,
  };
}

export function fromPriceRule(rule: Schemas["PriceRule"]): PriceRuleFormValues {
  return {
    name: { zh: rule.name.zh ?? "", en: rule.name.en ?? "", km: rule.name.km ?? "" },
    audience: rule.audience,
    priceUsd: formatUsd(rule.priceCents).slice(1),
    quota: rule.quota,
    saleStartsAt: rule.saleStartsAt ? dayjs(rule.saleStartsAt) : null,
    saleEndsAt: rule.saleEndsAt ? dayjs(rule.saleEndsAt) : null,
    sortOrder: rule.sortOrder,
    categoryIds: [...rule.categoryIds],
  };
}

export function toPriceRuleInput(values: PriceRuleFormValues): Schemas["PriceRuleInput"] {
  const priceCents = parseUsdToCents(values.priceUsd);
  if (priceCents === null) {
    throw new Error(`invalid price: ${values.priceUsd}`);
  }
  return {
    name: { zh: values.name.zh.trim(), en: values.name.en.trim(), km: values.name.km.trim() },
    audience: values.audience,
    priceCents,
    quota: values.quota ?? null,
    saleStartsAt: values.saleStartsAt ? values.saleStartsAt.toISOString() : null,
    saleEndsAt: values.saleEndsAt ? values.saleEndsAt.toISOString() : null,
    sortOrder: values.sortOrder ?? 0,
    categoryIds: values.categoryIds,
  };
}

/** 已有报名占用（used + reserved > 0）时，价格、人群、关联组别不可编辑（spec §7） */
export function isPriceRuleLocked(rule: Schemas["PriceRule"] | undefined): boolean {
  return rule !== undefined && rule.usedCount + rule.reservedCount > 0;
}

/** 服务端字段路径 → 表单 NamePath；priceCents 对应表单里的 priceUsd */
export function priceRuleFieldPath(field: string): (string | number)[] {
  return field === "priceCents" ? ["priceUsd"] : toNamePath(field);
}
