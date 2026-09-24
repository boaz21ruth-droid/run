import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { halfMarathon, jsonResponse } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

const paidHalf = { ...halfMarathon, fromPriceCents: 1500 };

const freeRun = {
  ...halfMarathon,
  id: 3,
  slug: "riverside-sunday-run",
  eventType: "FREE_ACTIVITY" as const,
  name: "Riverside Sunday Run",
  raceDate: "2026-10-18",
  fromPriceCents: null,
  categories: [{ ...halfMarathon.categories[0]!, id: 31, code: "5K", distanceM: 5000, capacity: 150, remaining: 120 }],
};

describe("HomePage", () => {
  it("首屏显示下一场赛事、真实统计与近期赛事卡片", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/", async () => jsonResponse(200, { items: [paidHalf, freeRun] }));

    const next = await screen.findByTestId("next-race");
    // 比赛日最近的一场是 10 月的免费活动
    expect(next).toHaveTextContent("Riverside Sunday Run");
    expect(next).toHaveTextContent("Free entry");
    expect(next).toHaveTextContent("120 spots left");
    expect(screen.getByTestId("next-race-register")).toHaveAttribute("href", "/events/riverside-sunday-run/free-signup");

    // 统计：2 场开放报名；名额 = 两场 remaining 之和
    expect(screen.getByText("races open for registration").previousSibling).toHaveTextContent("2");
    // 800 + 1200 + 120，按英文分位
    expect(screen.getByText("spots available").previousSibling).toHaveTextContent("2,120");

    const cards = screen.getAllByTestId("event-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("from $15.00");
    expect(screen.getAllByTestId("event-status").map((el) => el.textContent)).toEqual(["Open", "Free"]);
    expect(screen.getByRole("heading", { name: "How registration works" })).toBeInTheDocument();
  });

  it("没有赛事时首屏不显示下一场，列表显示空状态", async () => {
    window.localStorage.setItem("werun.lang", "zh");
    renderApp("/", async () => jsonResponse(200, { items: [] }));
    expect(await screen.findByText("暂时没有开放的赛事")).toBeInTheDocument();
    expect(screen.queryByTestId("next-race")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("每一步，都值得被记录。");
  });
});
