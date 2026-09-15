import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { inTelegram, orderDetail, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

const PATH = "/orders/WR7K2M9QXA";

describe("OrderDetailPage", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("待付款订单显示状态、金额构成、去付款与取消", async () => {
    renderApp(PATH, runnerRoutes({ "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()) }), inTelegram);

    const status = await screen.findByTestId("order-status");
    expect(status).toHaveAttribute("data-status", "PENDING_PAYMENT");
    expect(status).toHaveTextContent("Awaiting payment");
    expect(screen.getByTestId("order-deadline")).toHaveTextContent("Please pay before");
    expect(screen.getByTestId("order-list-amount")).toHaveTextContent("$50.00");
    expect(screen.getByTestId("order-coupon-discount")).toHaveTextContent("-$10.00");
    expect(screen.getByTestId("order-ident-offset")).toHaveTextContent("-$0.01");
    expect(screen.getByTestId("order-amount")).toHaveTextContent("$39.99");
    expect(screen.getByRole("row", { name: /Chan Sophea/ })).toHaveTextContent("$19.99");
    expect(screen.getByRole("row", { name: /Lim Dara/ })).toHaveTextContent("Half marathon");
    expect(screen.getByTestId("order-pay")).toHaveAttribute("href", "/orders/WR7K2M9QXA/pay");
    expect(screen.getByTestId("order-cancel")).toBeInTheDocument();
  });

  it("取消需要二次确认，成功后显示已取消", async () => {
    const user = userEvent.setup();
    const cancelled = orderDetail({
      status: "CANCELLED",
      deadlineAt: null,
      participants: orderDetail().participants.map((p) => ({ ...p, registrationStatus: "CANCELLED" as const })),
    });
    renderApp(
      PATH,
      runnerRoutes({
        "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()),
        "POST /api/app/orders/WR7K2M9QXA/cancel": () => jsonResponse(200, cancelled),
      }),
      inTelegram,
    );

    await user.click(await screen.findByTestId("order-cancel"));
    await user.click(screen.getByTestId("order-cancel-keep"));
    expect(screen.getByTestId("order-status")).toHaveAttribute("data-status", "PENDING_PAYMENT");

    await user.click(screen.getByTestId("order-cancel"));
    await user.click(screen.getByTestId("order-cancel-confirm"));

    expect(await screen.findByText("Cancelled", { selector: "[data-testid='order-status']" })).toBeInTheDocument();
    expect(screen.getByTestId("order-status")).toHaveAttribute("data-status", "CANCELLED");
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
  });

  it("取消失败时显示服务端文案", async () => {
    const user = userEvent.setup();
    renderApp(
      PATH,
      runnerRoutes({
        "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()),
        "POST /api/app/orders/WR7K2M9QXA/cancel": () =>
          jsonResponse(409, { error: { code: "ORDER_STATE_CONFLICT", message: "This action isn't allowed for the order's current status." } }),
      }),
      inTelegram,
    );

    await user.click(await screen.findByTestId("order-cancel"));
    await user.click(screen.getByTestId("order-cancel-confirm"));

    expect(await screen.findByTestId("form-error")).toHaveTextContent("This action isn't allowed for the order's current status.");
  });

  it("凭证被驳回时只显示去付款，已确认订单两个按钮都不显示", async () => {
    const { unmount } = renderApp(
      PATH,
      runnerRoutes({ "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail({ status: "PROOF_REJECTED" })) }),
      inTelegram,
    );
    expect(await screen.findByTestId("order-pay")).toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
    unmount();

    renderApp(
      PATH,
      runnerRoutes({
        "GET /api/app/orders/WR7K2M9QXA": () =>
          jsonResponse(200, orderDetail({ status: "PAID", deadlineAt: null, paidAt: "2026-09-14T04:00:00Z" })),
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PAID");
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-deadline")).not.toBeInTheDocument();
  });

  it("订单不存在时显示 404 页面", async () => {
    renderApp(
      "/orders/WR00000000",
      runnerRoutes({
        "GET /api/app/orders/WR00000000": () => jsonResponse(404, { error: { code: "ORDER_NOT_FOUND", message: "Order not found" } }),
      }),
      inTelegram,
    );
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});
