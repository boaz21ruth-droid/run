import type { Schemas } from "@werun/api-client";

export const opsMe: Schemas["Me"] = {
  staff: { id: 2, username: "ops.chan", fullName: "Chanthou Ny", role: "OPS" },
  permissions: {
    event_config: "write",
    event_publish: "write",
    order_view: "read",
    price_config: "write",
    coupon_manage: "write",
  },
};

export const adminMe: Schemas["Me"] = {
  staff: { id: 1, username: "admin.sovann", fullName: "Sovann Kea", role: "ADMIN" },
  permissions: {
    event_config: "read",
    event_publish: "read",
    access_manage: "write",
    price_config: "read",
    coupon_manage: "read",
  },
};

export const photographerMe: Schemas["Me"] = {
  staff: { id: 9, username: "photog.sok", fullName: "Sokha Ith", role: "PHOTOGRAPHER" },
  permissions: { photo_upload: "write", photo_tag: "write" },
};

export const draftEvent: Schemas["AdminEvent"] = {
  id: 7,
  slug: "phnom-penh-half-2026",
  eventType: "RACE",
  organizerType: "OFFICIAL",
  name: { zh: "金边半程马拉松 2026", en: "Phnom Penh Half Marathon 2026", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦" },
  city: "Phnom Penh",
  raceDate: "2026-11-15",
  timezone: "Asia/Phnom_Penh",
  status: "DRAFT",
  publicVisible: false,
  publishedAt: null,
  registrationOpen: false,
  registrationOpensAt: null,
  registrationClosesAt: null,
  categories: [
    {
      id: 11,
      code: "21K",
      name: { zh: "半程", en: "Half marathon", km: "ពាក់កណ្ដាល" },
      distanceM: 21097,
      capacity: 800,
      startAt: "2026-11-14T23:00:00Z",
      cutoffAt: "2026-11-15T02:30:00Z",
    },
  ],
};

export const publishedEvent: Schemas["AdminEvent"] = {
  ...draftEvent,
  status: "PUBLISHED",
  publicVisible: true,
  publishedAt: "2026-09-14T03:00:00Z",
};

export const unauthenticated = {
  error: { code: "UNAUTHENTICATED", message: "Please sign in" },
};

export const earlyBirdRule: Schemas["PriceRule"] = {
  id: 31,
  eventId: 7,
  name: { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន" },
  audience: "ALL",
  priceCents: 2500,
  currency: "USD",
  quota: 100,
  saleStartsAt: "2026-09-20T01:00:00Z",
  saleEndsAt: null,
  sortOrder: 1,
  categoryIds: [11],
  usedCount: 0,
  reservedCount: 0,
};

export const earlyCoupon: Schemas["Coupon"] = {
  id: 41,
  code: "EARLY_2026",
  eventId: 7,
  discountType: "PERCENT",
  discountValue: 20,
  quota: 50,
  minRunners: 2,
  validFrom: null,
  validUntil: "2026-10-31T16:59:00Z",
  status: "ACTIVE",
  usedCount: 3,
  reservedCount: 1,
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
