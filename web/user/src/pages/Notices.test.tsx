import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { daraProfile, halfMarathon, jsonResponse } from "../test/fixtures";
import { inTelegram, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

describe("主办方通知与无账号说明", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("「我的赛事」顶部显示主办方通知，链接到赛事", async () => {
    renderApp(
      "/orders",
      runnerRoutes({
        "GET /api/app/orders": () => jsonResponse(200, { items: [] }),
        "GET /api/app/free-signups": () => jsonResponse(200, { items: [] }),
        "GET /api/app/notices": () =>
          jsonResponse(200, {
            items: [
              {
                id: 3,
                eventSlug: halfMarathon.slug,
                eventName: halfMarathon.name,
                body: "Race-pack pickup: 13–14 Nov, Aeon 1.",
                createdAt: "2026-11-05T10:00:00Z",
              },
            ],
          }),
      }),
      inTelegram,
    );
    const notices = await screen.findByTestId("notices");
    expect(notices).toHaveTextContent("From the organizer");
    expect(notices).toHaveTextContent("Race-pack pickup: 13–14 Nov, Aeon 1.");
    expect(screen.getByRole("link", { name: halfMarathon.name })).toHaveAttribute("href", `/events/${halfMarathon.slug}`);
  });

  it("没有通知时不显示这一块", async () => {
    renderApp(
      "/orders",
      runnerRoutes({
        "GET /api/app/orders": () => jsonResponse(200, { items: [] }),
        "GET /api/app/free-signups": () => jsonResponse(200, { items: [] }),
        "GET /api/app/notices": () => jsonResponse(200, { items: [] }),
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("orders-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("notices")).not.toBeInTheDocument();
  });

  it("报名第 1 步说明无需注册账号", async () => {
    renderApp(
      `/events/${halfMarathon.slug}/register`,
      runnerRoutes({
        [`GET /api/events/${halfMarathon.slug}`]: () => jsonResponse(200, halfMarathon),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("register-no-account")).toHaveTextContent("No account needed");
  });
});
