import { screen, waitFor, within } from "@testing-library/react";
import dayjs from "dayjs";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, draftEvent, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { fillDateField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function patchRequest(requests: Request[]): Request | undefined {
  return requests.find(
    (request) => request.method === "PATCH" && new URL(request.url).pathname === "/api/admin/events/7/registration",
  );
}

describe("赛事详情", () => {
  it("从赛事列表点击名称进入详情页", async () => {
    const { router } = renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
      "GET /api/admin/events/7": () => jsonResponse(200, draftEvent),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-open-phnom-penh-half-2026"));

    expect(await screen.findByRole("heading", { name: "Phnom Penh Half Marathon 2026" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events/7");
    expect(screen.getByText("Asia/Phnom_Penh")).toBeInTheDocument();
    expect(screen.getByText("21K")).toBeInTheDocument();
    expect(screen.getByTestId("event-tab-basic")).toBeInTheDocument();
  });

  it("开放报名未就绪：显示服务端列出的每条原因", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "PATCH /api/admin/events/7/registration": () =>
        jsonResponse(422, {
          error: {
            code: "REGISTRATION_NOT_READY",
            message: "Registration can't be opened yet. Fix the items listed below.",
            fields: {
              priceRules: "These categories have no price tier: 21K.",
              paymentAccounts: "There is no active USD payment account for this event's registration.",
            },
          },
        }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-registration-switch"));
    await user.click(screen.getByTestId("event-registration-save"));

    const alert = await screen.findByTestId("event-registration-not-ready");
    expect(within(alert).getByText("Registration can't be opened yet. Fix the items listed below.")).toBeInTheDocument();
    expect(within(alert).getByText("These categories have no price tier: 21K.")).toBeInTheDocument();
    expect(
      within(alert).getByText("There is no active USD payment account for this event's registration."),
    ).toBeInTheDocument();
    expect(await patchRequest(requests)?.clone().json()).toEqual({ open: true, opensAt: null, closesAt: null });
    expect(patchRequest(requests)?.headers.get("X-WeRun-Client")).toBe("admin");
  });

  it("保存报名开关与开始时间", async () => {
    const opened = { ...publishedEvent, registrationOpen: true, registrationOpensAt: "2026-09-20T01:00:00Z" };
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "PATCH /api/admin/events/7/registration": () => jsonResponse(200, opened),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-registration-switch"));
    await fillDateField(user, "registration_opensAt", "2026-09-20 08:00");
    await user.click(screen.getByTestId("event-registration-save"));

    expect(await screen.findByText("Registration settings saved")).toBeInTheDocument();
    expect(screen.queryByTestId("event-registration-not-ready")).not.toBeInTheDocument();
    expect(await patchRequest(requests)?.clone().json()).toEqual({
      open: true,
      opensAt: dayjs("2026-09-20 08:00", "YYYY-MM-DD HH:mm").toISOString(),
      closesAt: null,
    });
    await waitFor(() => {
      expect(screen.getByTestId("event-registration-switch")).toHaveAttribute("aria-checked", "true");
    });
  });

  it("ADMIN 只读：开关不可操作，没有保存按钮", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
    });

    expect(await screen.findByTestId("event-registration-switch")).toBeDisabled();
    expect(screen.queryByTestId("event-registration-save")).not.toBeInTheDocument();
  });
});
