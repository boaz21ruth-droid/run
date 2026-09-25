import type { Schemas } from "@werun/api-client";
import { apiRoutes, jsonResponse, runnerSession } from "./fixtures";

type RouteHandler = Parameters<typeof apiRoutes>[0][string];

/** 已在 Telegram 中打开：renderApp 的第三个参数 */
export const inTelegram = { initData: "signed-init-data" };

/** apiRoutes 加上 initData 登录接口，适用于 RequireRunner 内的页面 */
export function runnerRoutes(table: Record<string, RouteHandler>) {
  return apiRoutes({ "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()), ...table });
}

export const consentEn: Schemas["ConsentVersion"] = {
  version: "REG-E2E-v1",
  lang: "en",
  effectiveDate: "2026-01-01",
  fullText: "By registering you agree to the race rules.",
  items: [
    { key: "rules", title: "Race rules", description: "I will follow the race rules." },
    { key: "health", title: "Health", description: "I am fit to take part." },
    { key: "terms", title: "Terms", description: "I accept the registration terms." },
  ],
};

export function quoteFor(runners: number, couponCents = 0): Schemas["Quote"] {
  const list = 2500 * runners;
  const amount = list - couponCents;
  return {
    participants: Array.from({ length: runners }, () => ({
      categoryId: 11,
      priceRuleId: 7,
      audience: "ALL" as const,
      listPriceCents: 2500,
      paidCents: Math.floor(amount / runners),
    })),
    listAmountCents: list,
    couponApplied: couponCents > 0,
    couponDiscountCents: couponCents,
    identOffsetCents: 0,
    discountCents: couponCents,
    amountCents: amount,
    currency: "USD",
  };
}

const eventName = {
  zh: "金边半程马拉松 2026",
  en: "Phnom Penh Half Marathon 2026",
  km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
};

const halfName = { zh: "半程 21K", en: "Half marathon", km: "ពាក់កណ្ដាលម៉ារ៉ាតុង" };

export function orderDetail(overrides: Partial<Schemas["OrderDetail"]> = {}): Schemas["OrderDetail"] {
  return {
    orderNo: "WR7K2M9QXA",
    status: "PENDING_PAYMENT",
    eventSlug: "phnom-penh-half-2026",
    eventName,
    eventTimezone: "Asia/Phnom_Penh",
    listAmountCents: 5000,
    discountCents: 1001,
    identOffsetCents: 1,
    amountCents: 3999,
    currency: "USD",
    deadlineAt: "2026-09-14T03:30:00Z",
    paidAt: null,
    createdAt: "2026-09-14T03:00:00Z",
    participants: [
      {
        regNo: "RG4N8P2QTZ",
        categoryId: 11,
        categoryName: halfName,
        fullName: "Chan Sophea",
        priceRuleId: 7,
        listPriceCents: 2500,
        paidCents: 1999,
        registrationStatus: "PENDING",
      },
      {
        regNo: "RG5P9Q3RVW",
        categoryId: 11,
        categoryName: halfName,
        fullName: "Lim Dara",
        priceRuleId: 7,
        listPriceCents: 2500,
        paidCents: 2000,
        registrationStatus: "PENDING",
      },
    ],
    paymentAccount: {
      id: 3,
      name: "ABA USD",
      provider: "ABA",
      accountName: "WERUN CO LTD",
      accountNoMasked: "*** *** 123",
      qrFileId: 9,
    },
    ...overrides,
  };
}

export function orderSummary(overrides: Partial<Schemas["OrderSummary"]> = {}): Schemas["OrderSummary"] {
  return {
    orderNo: "WR7K2M9QXA",
    status: "PENDING_PAYMENT",
    eventSlug: "phnom-penh-half-2026",
    eventName,
    amountCents: 3999,
    currency: "USD",
    participantCount: 2,
    deadlineAt: "2026-09-14T03:30:00Z",
    createdAt: "2026-09-14T03:00:00Z",
    ...overrides,
  };
}

export function freeSignupSummary(overrides: Partial<Schemas["FreeSignupSummary"]> = {}): Schemas["FreeSignupSummary"] {
  return {
    signupNo: "FS7K2M9QXA",
    eventSlug: "riverside-family-run",
    eventName: { zh: "河畔亲子跑", en: "Riverside Family Run", km: "ការរត់គ្រួសារមាត់ទន្លេ" },
    raceDate: "2026-11-15",
    categoryName: { zh: "亲子 5K", en: "Family 5K", km: "គ្រួសារ 5K" },
    fullName: "Dara Sok",
    status: "REGISTERED",
    createdAt: "2026-09-25T10:09:00Z",
    ...overrides,
  };
}
