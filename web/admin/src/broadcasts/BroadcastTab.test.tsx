import { screen, waitFor } from "@testing-library/react";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { financeMe, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

const board = (items: Schemas["BroadcastItem"][] = []): Schemas["BroadcastBoard"] => ({
  audiences: [
    { audience: "PAID", count: 296 },
    { audience: "PENDING", count: 22 },
    { audience: "ELITE", count: 0 },
    { audience: "VOLUNTEERS", count: 73 },
  ],
  items,
});
const sentItem: Schemas["BroadcastItem"] = {
  id: 1,
  audience: "PAID",
  body: "Race-pack pickup: 13–14 Nov.",
  recipientCount: 296,
  sentCount: 280,
  failedCount: 2,
  senderName: "Chanthou Ny",
  createdAt: "2026-11-05T10:00:00Z",
};

describe("发通知", () => {
  it("选人群看到人数，确认后发送，历史显示送达情况", async () => {
    let sent: unknown = null;
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/broadcasts": () => jsonResponse(200, board()),
      "POST /api/admin/events/7/broadcasts": async (request) => {
        sent = await request.json();
        return jsonResponse(201, board([sentItem]));
      },
    });
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-broadcast"));
    expect(await screen.findByTestId("broadcast-audience-PAID")).toHaveTextContent("Paid · 296");
    expect(screen.getByTestId("broadcast-send")).toBeDisabled();

    await user.click(screen.getByTestId("broadcast-audience-ELITE"));
    await user.type(screen.getByTestId("broadcast-body"), "Elite briefing at 17:00");
    expect(screen.getByTestId("broadcast-send")).toBeDisabled();

    await user.click(screen.getByTestId("broadcast-audience-VOLUNTEERS"));
    await user.click(screen.getByTestId("broadcast-send"));
    expect(await screen.findByText("Send to 73 people (Volunteers)?")).toBeInTheDocument();
    await user.click(screen.getByTestId("broadcast-confirm"));
    await waitFor(() => expect(sent).toEqual({ audience: "VOLUNTEERS", body: "Elite briefing at 17:00" }));
    expect(await screen.findByText("Telegram: 280 delivered · 2 failed")).toBeInTheDocument();
  });

  it("只读角色看得到人数和历史，不能发", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/broadcasts": () => jsonResponse(200, board([sentItem])),
    });
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-broadcast"));
    expect(await screen.findByText("Race-pack pickup: 13–14 Nov.")).toBeInTheDocument();
    expect(screen.queryByTestId("broadcast-send")).not.toBeInTheDocument();
    expect(screen.getByTestId("broadcast-body")).toBeDisabled();
  });
});
