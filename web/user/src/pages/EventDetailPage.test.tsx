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

    const row = screen.getByRole("row", { name: /Half marathon/ });
    expect(row).toHaveTextContent("21.1 km");
    expect(row).toHaveTextContent("800");
    expect(row).toHaveTextContent("06:00");
    expect(row).toHaveTextContent("09:30");
  });

  it("赛事不存在时显示 404 页面", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/nope", async () =>
      jsonResponse(404, { error: { code: "EVENT_NOT_FOUND", message: "Event not found" } }),
    );
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});
