import { describe, expect, it } from "vitest";
import { currentTier, tierDeadline, type PriceTier } from "./tiers";

const tier = (over: Partial<PriceTier>): PriceTier => ({
  id: 1,
  name: "Standard",
  audience: "ALL",
  priceCents: 1900,
  currency: "USD",
  quota: null,
  remaining: null,
  saleStartsAt: null,
  saleEndsAt: null,
  state: "ON_SALE",
  ...over,
});

const now = new Date("2026-10-31T12:00:00Z");

describe("currentTier", () => {
  it("在面向所有人的在售档里取最便宜的", () => {
    const tiers = [
      tier({ id: 1, priceCents: 1500, state: "SOLD_OUT" }),
      tier({ id: 2, priceCents: 1900 }),
      tier({ id: 3, priceCents: 1200, audience: "LOCAL" }),
      tier({ id: 4, priceCents: 2400 }),
    ];
    expect(currentTier(tiers)?.id).toBe(2);
  });

  it("没有在售档时为空", () => {
    expect(currentTier([tier({ state: "ENDED" })])).toBeNull();
  });
});

describe("tierDeadline", () => {
  const flash = tier({ id: 2, name: "Flash", priceCents: 1900, saleEndsAt: "2026-11-06T17:00:00Z" });
  const last = tier({
    id: 3,
    name: "Last call",
    priceCents: 2400,
    state: "UPCOMING",
    saleStartsAt: "2026-11-06T17:00:00Z",
  });

  it("给出剩余天数与下一档", () => {
    const d = tierDeadline([flash, last], now);
    expect(d?.tier.id).toBe(2);
    expect(d?.daysLeft).toBe(7);
    expect(d?.next?.id).toBe(3);
  });

  it("当前档不限时间时不提示", () => {
    expect(tierDeadline([tier({ saleEndsAt: null }), last], now)).toBeNull();
  });

  it("之后不涨价时不提示", () => {
    expect(tierDeadline([flash, { ...last, priceCents: 1900 }], now)).toBeNull();
  });

  it("最后一天也至少显示 1 天", () => {
    expect(tierDeadline([flash, last], new Date("2026-11-06T16:00:00Z"))?.daysLeft).toBe(1);
  });
});
