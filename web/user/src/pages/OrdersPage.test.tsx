import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { freeSignupSummary, inTelegram, orderDetail, orderSummary, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

describe("OrdersPage", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("列出订单并进入详情", async () => {
    const { router } = renderApp(
      "/orders",
      runnerRoutes({
        "GET /api/app/orders": () =>
          jsonResponse(200, {
            items: [
              orderSummary(),
              orderSummary({ orderNo: "WR3H5J7K9M", status: "PAID", amountCents: 0, participantCount: 1, deadlineAt: null }),
            ],
          }),
        "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, orderDetail()),
        "GET /api/app/free-signups": () => jsonResponse(200, { items: [] }),
      }),
      inTelegram,
    );

    const first = await screen.findByTestId("order-item-WR7K2M9QXA");
    expect(first).toHaveTextContent("Awaiting payment");
    expect(first).toHaveTextContent("$39.99");
    expect(first).toHaveTextContent("Runners: 2");
    expect(first).toHaveTextContent("Phnom Penh Half Marathon 2026");
    expect(screen.getByTestId("order-item-WR3H5J7K9M")).toHaveTextContent("Confirmed");

    await userEvent.click(first);
    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/WR7K2M9QXA"));
  });

  it("没有订单时显示空状态", async () => {
    window.localStorage.setItem("werun.lang", "zh");
    renderApp(
      "/orders",
      runnerRoutes({
        "GET /api/app/orders": () => jsonResponse(200, { items: [] }),
        "GET /api/app/free-signups": () => jsonResponse(200, { items: [] }),
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("orders-empty")).toHaveTextContent("还没有订单或报名。");
  });

  it("只有免费报名时也列出来，并可进入活动详情", async () => {
    const { router } = renderApp(
      "/orders",
      runnerRoutes({
        "GET /api/app/orders": () => jsonResponse(200, { items: [] }),
        "GET /api/app/free-signups": () => jsonResponse(200, { items: [freeSignupSummary()] }),
      }),
      inTelegram,
    );

    const item = await screen.findByTestId("free-signup-item-FS7K2M9QXA");
    expect(item).toHaveTextContent("Registered");
    expect(item).toHaveTextContent("Riverside Family Run");
    expect(item).toHaveTextContent("Family 5K");
    expect(item).toHaveTextContent("Dara Sok");
    expect(item).toHaveTextContent("Free");
    expect(screen.queryByTestId("orders-empty")).not.toBeInTheDocument();

    await userEvent.click(item);
    await waitFor(() => expect(router.state.location.pathname).toBe("/events/riverside-family-run"));
  });
});
