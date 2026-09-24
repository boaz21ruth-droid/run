import { describe, expect, it } from "vitest";
import { halfMarathon } from "../test/fixtures";
import { distanceLabels, eventStatus, nextEvent, totalRemaining } from "./status";

function withRemaining(remaining: number[]) {
  return { ...halfMarathon, categories: halfMarathon.categories.map((c, i) => ({ ...c, remaining: remaining[i] ?? c.remaining })) };
}

describe("eventStatus", () => {
  it("开放且名额充足为 open", () => {
    expect(eventStatus(withRemaining([500, 900]))).toBe("open");
  });

  it("剩余不足 15% 为 almostFull，为 0 为 soldOut", () => {
    expect(eventStatus(withRemaining([100, 150]))).toBe("almostFull");
    expect(eventStatus(withRemaining([0, 0]))).toBe("soldOut");
  });

  it("报名开关关闭为 closed，未到开放时间为 upcoming", () => {
    expect(eventStatus({ ...halfMarathon, registrationOpen: false })).toBe("closed");
    expect(eventStatus({ ...halfMarathon, registrationOpensAt: "2099-01-01T00:00:00Z" })).toBe("upcoming");
  });

  it("免费活动开放为 free", () => {
    expect(eventStatus({ ...halfMarathon, eventType: "FREE_ACTIVITY" })).toBe("free");
  });
});

describe("nextEvent / totalRemaining / distanceLabels", () => {
  it("取比赛日最近且未过去的一场", () => {
    const later = { ...halfMarathon, slug: "later", raceDate: "2026-12-06" };
    const past = { ...halfMarathon, slug: "past", raceDate: "2020-01-01" };
    expect(nextEvent([later, halfMarathon, past], new Date("2026-09-24T00:00:00Z"))?.slug).toBe(halfMarathon.slug);
    expect(nextEvent([past], new Date("2026-09-24T00:00:00Z"))?.slug).toBe("past");
    expect(nextEvent([])).toBeNull();
  });

  it("剩余名额求和，距离标签从长到短且去重", () => {
    expect(totalRemaining(withRemaining([10, 20]))).toBe(30);
    expect(distanceLabels(halfMarathon)).toEqual(["21K", "10K"]);
  });
});
