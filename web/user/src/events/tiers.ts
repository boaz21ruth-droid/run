import type { Schemas } from "@werun/api-client";

export type PriceTier = Schemas["PublicPriceTier"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 当前主推的在售档：面向所有人（ALL）的在售档里最便宜的一个；没有则为空 */
export function currentTier(tiers: readonly PriceTier[]): PriceTier | null {
  let best: PriceTier | null = null;
  for (const t of tiers) {
    if (t.state !== "ON_SALE" || t.audience !== "ALL") continue;
    if (!best || t.priceCents < best.priceCents) best = t;
  }
  return best;
}

export interface TierDeadline {
  tier: PriceTier;
  /** 距离当前档结束的整天数，向上取整，至少为 1 */
  daysLeft: number;
  /** 当前档结束后接着开卖、面向所有人的下一档；没有则为空 */
  next: PriceTier | null;
}

/**
 * 当前档有截止时间、且后面还有更贵的档时，给出「还剩 N 天，之后涨到 $X」的提示数据；
 * 当前档不限时间或之后不涨价时返回空，不制造假紧迫感。
 */
export function tierDeadline(tiers: readonly PriceTier[], now: Date = new Date()): TierDeadline | null {
  const tier = currentTier(tiers);
  if (!tier?.saleEndsAt) return null;
  const endsAt = new Date(tier.saleEndsAt).getTime();
  const next =
    tiers
      .filter(
        (t) =>
          t.audience === "ALL" &&
          t.state === "UPCOMING" &&
          t.saleStartsAt != null &&
          new Date(t.saleStartsAt).getTime() >= endsAt - DAY_MS,
      )
      .sort((a, b) => new Date(a.saleStartsAt ?? 0).getTime() - new Date(b.saleStartsAt ?? 0).getTime())[0] ?? null;
  if (!next || next.priceCents <= tier.priceCents) return null;
  const daysLeft = Math.max(1, Math.ceil((endsAt - now.getTime()) / DAY_MS));
  return { tier, daysLeft, next };
}
