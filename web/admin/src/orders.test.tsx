import { screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { draftEvent, jsonResponse, photographerMe } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";
import { ORDER_NO, reviewerMe, orderDetail, orderSummary, supportMe } from "./test/reviewFixtures";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function setupFormUser() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

describe("订单", () => {
  it("按关键字查询订单，点击行进入详情显示金额构成、识别分与凭证记录", async () => {
    const { requests, router } = renderAdminApp("/orders", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
      "GET /api/admin/orders": () => jsonResponse(200, { items: [orderSummary], total: 1 }),
      "GET /api/admin/orders/501": () => jsonResponse(200, orderDetail),
    });

    await screen.findByTestId(`order-row-${ORDER_NO}`);
    const user = setupFormUser();
    await user.click(document.querySelector<HTMLElement>("#orderFilter_q")!);
    await user.paste("+85512");
    await user.click(screen.getByTestId("order-filter-submit"));

    await waitFor(() => {
      const last = requests.filter((request) => new URL(request.url).pathname === "/api/admin/orders").at(-1)!;
      const params = new URL(last.url).searchParams;
      expect(params.get("q")).toBe("+85512");
      expect(params.get("limit")).toBe("20");
      expect(params.get("offset")).toBe("0");
    });

    await user.click(await screen.findByTestId(`order-row-${ORDER_NO}`));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/501"));
    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
    expect(screen.getByTestId("order-ident-offset")).toHaveTextContent("$0.49");
    expect(screen.getByTestId("order-amount")).toHaveTextContent("$24.51");
    expect(screen.getByText("PF8H2K4M6N")).toBeInTheDocument();
    expect(screen.getByText("+85512345678")).toBeInTheDocument();
  });

  it("SUPPORT 没有赛事权限：不请求赛事列表，仍能查看订单", async () => {
    const { requests } = renderAdminApp("/orders", {
      "GET /api/admin/me": () => jsonResponse(200, supportMe),
      "GET /api/admin/orders": () => jsonResponse(200, { items: [orderSummary], total: 1 }),
    });

    expect(await screen.findByTestId(`order-row-${ORDER_NO}`)).toBeInTheDocument();
    expect(requests.some((request) => new URL(request.url).pathname === "/api/admin/events")).toBe(false);
    expect(document.querySelector("#orderFilter_eventId")).toBeNull();
  });

  it("摄影师没有 order_view：显示 403 且菜单不显示订单", async () => {
    renderAdminApp("/orders", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Orders/ })).not.toBeInTheDocument();
  });
});
