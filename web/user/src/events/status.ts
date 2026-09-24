import type { Schemas } from "@werun/api-client";
import { registrationAvailable } from "../register/model";

export type PublicEvent = Schemas["PublicEvent"];

/** 卡片与详情页上展示的赛事状态：一次只显示一个，按重要性取第一个成立的 */
export type EventStatus = "soldOut" | "almostFull" | "open" | "free" | "upcoming" | "closed";

/** 剩余名额低于总名额的这个比例时标为"名额紧张" */
const ALMOST_FULL_RATIO = 0.15;

export function totalCapacity(event: PublicEvent): number {
  return event.categories.reduce((sum, c) => sum + c.capacity, 0);
}

/** 剩余名额：后端给了 remaining 就用它；旧数据只有 soldOut 时按已满记 0、未满记满额 */
export function totalRemaining(event: PublicEvent): number {
  return event.categories.reduce((sum, c) => sum + (c.remaining ?? (c.soldOut ? 0 : c.capacity)), 0);
}

export function eventStatus(event: PublicEvent, now: Date = new Date()): EventStatus {
  if (event.eventType === "FREE_ACTIVITY") {
    if (!event.registrationOpen) {
      return "closed";
    }
    return totalRemaining(event) <= 0 ? "soldOut" : "free";
  }
  if (!event.registrationOpen) {
    return "closed";
  }
  if (event.registrationOpensAt && Date.parse(event.registrationOpensAt) > now.getTime()) {
    return "upcoming";
  }
  if (!registrationAvailable(event, now)) {
    return "closed";
  }
  const remaining = totalRemaining(event);
  const capacity = totalCapacity(event);
  if (remaining <= 0) {
    return "soldOut";
  }
  if (capacity > 0 && remaining / capacity < ALMOST_FULL_RATIO) {
    return "almostFull";
  }
  return "open";
}

/** 首页"下一场"：比赛日在今天（含）之后、日期最近的一场；全是过去的赛事时取列表第一场 */
export function nextEvent(events: readonly PublicEvent[], now: Date = new Date()): PublicEvent | null {
  if (events.length === 0) {
    return null;
  }
  const today = now.toISOString().slice(0, 10);
  const upcoming = [...events].filter((e) => e.raceDate >= today).sort((a, b) => a.raceDate.localeCompare(b.raceDate));
  return upcoming[0] ?? events[0] ?? null;
}

/** 组别距离用于封面：按距离从长到短，去重，最多 4 个（21.1 → "21K"，5 → "5K"，42.195 → "42K"） */
export function distanceLabels(event: PublicEvent): string[] {
  const kms = [...new Set(event.categories.map((c) => Math.round(c.distanceM / 1000)))].sort((a, b) => b - a);
  return kms.slice(0, 4).map((km) => `${km}K`);
}
