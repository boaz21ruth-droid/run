import type { Schemas } from "@werun/api-client";
import { halfMarathon } from "./fixtures";

const baseCategory = halfMarathon.categories[0]!;

/** 免费活动：501 无年龄限制，502 最低 12 岁，503 已满 */
export const freeActivity: Schemas["PublicEvent"] = {
  ...halfMarathon,
  slug: "riverside-fun-walk",
  name: "Riverside Fun Walk",
  eventType: "FREE_ACTIVITY",
  registrationOpen: true,
  categories: [
    { ...baseCategory, id: 501, code: "5K", name: "Family 5K", distanceM: 5000, capacity: 300, minAge: 0, soldOut: false },
    { ...baseCategory, id: 502, code: "10K", name: "Trail 10K", distanceM: 10000, capacity: 100, minAge: 12, soldOut: false },
    { ...baseCategory, id: 503, code: "3K", name: "Sunrise 3K", distanceM: 3000, capacity: 50, minAge: 0, soldOut: true },
  ],
};

export const registrationConsent = {
  version: "REG-TEST-v1",
  lang: "en",
  effectiveDate: "2026-01-01",
  fullText: "Registration consent full text.",
  items: [
    { key: "rules", title: "I will follow the event rules", description: "Cut-off times apply" },
    { key: "health", title: "I am fit to take part", description: "Ask a doctor if unsure" },
    { key: "terms", title: "I accept the terms", description: "Data is used only for this event" },
  ],
};

export const runnerSession = {
  token: "test-runner-token",
  expiresAt: "2099-01-01T00:00:00Z",
  user: { id: 7, telegramUserId: 7001, telegramUsername: "dara", displayName: "Dara Sok", locale: "en" },
};

/** 让 RequireRunner 视为已登录：令牌与开发登录参数都写入 sessionStorage（契约补充 7） */
export function presetRunnerSession(): void {
  window.sessionStorage.setItem("werun.appToken", runnerSession.token);
  window.sessionStorage.setItem("werun.appTokenExpiresAt", runnerSession.expiresAt);
  window.sessionStorage.setItem("werun.devInitData", "user=%7B%22id%22%3A7001%7D&auth_date=1&hash=test");
}
