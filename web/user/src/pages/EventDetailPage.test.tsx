import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { halfMarathon, jsonResponse } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

describe("EventDetailPage", () => {
  it("显示组别的距离、名额与金边时间", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, halfMarathon));

    expect(await screen.findByRole("heading", { name: "Phnom Penh Half Marathon 2026" })).toBeInTheDocument();
    expect(new URL(requests[0]!.url).pathname).toBe("/api/events/phnom-penh-half-2026");

    const card = screen.getByTestId("category-21K");
    expect(card).toHaveTextContent("Half marathon");
    expect(card).toHaveTextContent("21.1");
    expect(card).toHaveTextContent("800 / 800");
    expect(card).toHaveTextContent("06:00");
    expect(card).toHaveTextContent("09:30");
  });

  it("赛事不存在时显示 404 页面", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/nope", async () =>
      jsonResponse(404, { error: { code: "EVENT_NOT_FOUND", message: "Event not found" } }),
    );
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });

  it("RACE 开放报名且有余额时显示报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, halfMarathon));

    const button = await screen.findByTestId("register-button");
    expect(button).toHaveAttribute("href", "/events/phnom-penh-half-2026/register");
    expect(button).toHaveTextContent("Register");
  });

  it("未开放报名时不显示报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, { ...halfMarathon, registrationOpen: false }));

    expect(await screen.findByRole("heading", { name: "Phnom Penh Half Marathon 2026" })).toBeInTheDocument();
    expect(screen.queryByTestId("register-button")).not.toBeInTheDocument();
  });

  it("所有组别售罄时显示已满", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const soldOut = { ...halfMarathon, categories: halfMarathon.categories.map((c) => ({ ...c, soldOut: true })) };
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, soldOut));

    expect(await screen.findByTestId("register-sold-out")).toHaveTextContent("All categories are sold out.");
    expect(screen.queryByTestId("register-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("category-21K")).toHaveTextContent("Sold out");
  });

  it("显示价格档时间线、涨价提示、已报名人数，报名按钮带当前档", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const base = { audience: "ALL" as const, currency: "USD", quota: null, remaining: null, saleStartsAt: null, saleEndsAt: null };
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60_000).toISOString();
    const withTiers = {
      ...halfMarathon,
      registeredCount: 318,
      priceTiers: [
        { ...base, id: 1, name: "Early bird", priceCents: 1500, quota: 150, remaining: 0, state: "SOLD_OUT" as const },
        { ...base, id: 2, name: "Flash", priceCents: 1900, quota: 300, remaining: 142, saleEndsAt: soon, state: "ON_SALE" as const },
        { ...base, id: 3, name: "Last call", priceCents: 2400, saleStartsAt: soon, state: "UPCOMING" as const },
      ],
    };
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, withTiers));

    expect(await screen.findByTestId("tier-1")).toHaveTextContent("Sold out");
    expect(screen.getByTestId("tier-2")).toHaveTextContent("142 / 300 left");
    expect(screen.getByTestId("tier-3")).toHaveTextContent("Not yet");
    expect(screen.getByTestId("tier-deadline")).toHaveTextContent("Flash ends in 3 days, then $24.00.");
    expect(screen.getByTestId("registered-count")).toHaveTextContent("318 runners registered");
    expect(screen.getByTestId("register-button")).toHaveTextContent("Register · Flash $19.00");
  });

  it("没有人报名时不显示已报名人数", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, halfMarathon));

    expect(await screen.findByTestId("share-button")).toBeInTheDocument();
    expect(screen.queryByTestId("registered-count")).not.toBeInTheDocument();
  });
});
