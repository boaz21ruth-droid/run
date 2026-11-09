import { formatUsd, type Schemas } from "@werun/api-client";
import type { TFunction } from "i18next";

/** 打开推荐链接后记下的来源，报名时带上（推荐码 + 渠道归因） */
export interface StoredReferral {
  slug: string;
  eventSlug: string;
  label: string;
  couponCode: string | null;
  offer: Schemas["CouponOffer"] | null;
  savedAt: number;
}

const STORAGE_KEY = "werun.referral";
/** 推荐来源保留 30 天：跑者常常先看、过几天再报 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readAll(): Record<string, StoredReferral> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredReferral>) : {};
  } catch {
    return {};
  }
}

/** 按赛事保存；同一赛事后打开的链接覆盖先打开的 */
export function saveReferral(visit: Schemas["ReferralVisit"], slug: string, now = Date.now()): void {
  const all = readAll();
  all[visit.eventSlug] = {
    slug,
    eventSlug: visit.eventSlug,
    label: visit.label,
    couponCode: visit.couponCode,
    offer: visit.offer,
    savedAt: now,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 无痕模式或存储被禁用：只是少了归因，不影响报名
  }
}

export function loadReferral(eventSlug: string, now = Date.now()): StoredReferral | null {
  const r = readAll()[eventSlug];
  if (!r || typeof r.slug !== "string" || typeof r.savedAt !== "number" || now - r.savedAt > TTL_MS) {
    return null;
  }
  return r;
}

/** 推荐码优惠的一句话说明 */
export function offerText(t: TFunction<"user">, offer: Schemas["CouponOffer"]): string {
  switch (offer.discountType) {
    case "PRICE":
      return offer.discountValue === 0 ? t("referral.offer.free") : t("referral.offer.price", { price: formatUsd(offer.discountValue) });
    case "AMOUNT":
      return t("referral.offer.amount", { amount: formatUsd(offer.discountValue) });
    case "PERCENT":
      return t("referral.offer.percent", { n: offer.discountValue });
    case "WAIVER":
      return t("referral.offer.free");
  }
}
