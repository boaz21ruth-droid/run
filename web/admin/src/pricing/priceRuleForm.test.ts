import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { earlyBirdRule } from "../test/fixtures";
import {
  emptyPriceRule,
  fromPriceRule,
  isPriceRuleLocked,
  priceRuleFieldPath,
  toPriceRuleInput,
  type PriceRuleFormValues,
} from "./priceRuleForm";

describe("toPriceRuleInput", () => {
  it("美元字符串转分、去掉名称首尾空格、空值转 null", () => {
    const values: PriceRuleFormValues = {
      ...emptyPriceRule([11, 12]),
      name: { zh: " 早鸟价 ", en: "Early bird", km: "តម្លៃទិញមុន" },
      priceUsd: "25.5",
      saleStartsAt: dayjs("2026-09-20T01:00:00Z"),
    };

    expect(toPriceRuleInput(values)).toEqual({
      name: { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន" },
      audience: "ALL",
      priceCents: 2550,
      quota: null,
      saleStartsAt: "2026-09-20T01:00:00.000Z",
      saleEndsAt: null,
      sortOrder: 0,
      categoryIds: [11, 12],
    });
  });

  it("价格无法解析时抛错（表单校验保证不会走到这里）", () => {
    expect(() => toPriceRuleInput({ ...emptyPriceRule([11]), priceUsd: "25.505" })).toThrow("invalid price");
  });
});

describe("fromPriceRule", () => {
  it("回填编辑表单", () => {
    const values = fromPriceRule(earlyBirdRule);

    expect(values.priceUsd).toBe("25.00");
    expect(values.quota).toBe(100);
    expect(values.saleStartsAt?.toISOString()).toBe("2026-09-20T01:00:00.000Z");
    expect(values.saleEndsAt).toBeNull();
    expect(values.categoryIds).toEqual([11]);
    expect(toPriceRuleInput(values).priceCents).toBe(2500);
  });
});

describe("isPriceRuleLocked 与字段映射", () => {
  it("已用或预留大于 0 时锁定", () => {
    expect(isPriceRuleLocked(undefined)).toBe(false);
    expect(isPriceRuleLocked(earlyBirdRule)).toBe(false);
    expect(isPriceRuleLocked({ ...earlyBirdRule, reservedCount: 1 })).toBe(true);
    expect(isPriceRuleLocked({ ...earlyBirdRule, usedCount: 2 })).toBe(true);
  });

  it("服务端字段映射到表单字段", () => {
    expect(priceRuleFieldPath("priceCents")).toEqual(["priceUsd"]);
    expect(priceRuleFieldPath("name.km")).toEqual(["name", "km"]);
    expect(priceRuleFieldPath("quota")).toEqual(["quota"]);
  });
});
