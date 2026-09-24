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
});
