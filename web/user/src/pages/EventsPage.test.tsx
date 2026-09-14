import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { halfMarathon, jsonResponse } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

describe("EventsPage", () => {
  it("用接口返回的数据渲染赛事卡片", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderApp("/events", async () => jsonResponse(200, { items: [halfMarathon] }));

    const cards = await screen.findAllByTestId("event-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Phnom Penh Half Marathon 2026");
    expect(cards[0]).toHaveTextContent("15 November 2026");
    expect(new URL(requests[0]!.url).pathname).toBe("/api/events");
    expect(requests[0]!.headers.get("Accept-Language")).toBe("en");
    expect(screen.getByRole("heading", { name: "All events" })).toBeInTheDocument();
  });

  it("没有赛事时显示空状态", async () => {
    window.localStorage.setItem("werun.lang", "zh");
    renderApp("/events", async () => jsonResponse(200, { items: [] }));
    expect(await screen.findByText("暂时没有开放的赛事")).toBeInTheDocument();
  });

  it("接口失败时显示错误和重试按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events", async () => new Response("bad gateway", { status: 502 }));
    expect(await screen.findByText("Couldn't load. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("切换语言后更新 html lang 并用新语言重新请求", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderApp("/events", async () => jsonResponse(200, { items: [halfMarathon] }));
    await screen.findAllByTestId("event-card");

    await userEvent.click(screen.getByTestId("lang-switch-km"));

    expect(document.documentElement.lang).toBe("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
    await waitFor(() => {
      expect(requests.at(-1)!.headers.get("Accept-Language")).toBe("km");
    });
    expect(screen.getByTestId("lang-switch-km")).toHaveAttribute("aria-pressed", "true");
  });
});
