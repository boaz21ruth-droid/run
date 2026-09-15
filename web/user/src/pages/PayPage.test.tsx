import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { inTelegram, orderDetail, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

const ORDER_NO = "WR7K2M9QXA";
const ORDER_PATH = `/api/app/orders/${ORDER_NO}`;
const PATH = `/orders/${ORDER_NO}/pay`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-09-14T03:00:00Z"));
  window.localStorage.setItem("werun.lang", "en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PayPage", () => {
  it("显示收款码、户名、应付金额与识别分说明、订单号和上传入口", async () => {
    renderApp(PATH, runnerRoutes({ [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail()) }), inTelegram);

    expect(await screen.findByTestId("pay-qr")).toHaveAttribute("src", "/api/files/9");
    expect(screen.getByTestId("pay-amount")).toHaveTextContent("$39.99");
    expect(
      screen.getByText("Please transfer exactly this amount. The odd cents (1¢ off) help us identify your order."),
    ).toBeInTheDocument();
    expect(screen.getByText("WERUN CO LTD")).toBeInTheDocument();
    expect(screen.getByText("*** *** 123")).toBeInTheDocument();
    expect(screen.getByText("Phnom Penh Half Marathon 2026")).toBeInTheDocument();
    expect(screen.getByTestId("pay-order-no")).toHaveTextContent(ORDER_NO);
    expect(screen.getByTestId("pay-countdown")).toHaveTextContent("30:00");
    expect(screen.getByTestId("pay-upload-link")).toHaveAttribute("href", `/orders/${ORDER_NO}/proof`);
  });

  it("没有识别分时显示普通金额说明", async () => {
    renderApp(
      PATH,
      runnerRoutes({
        [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail({ identOffsetCents: 0, discountCents: 1000, amountCents: 4000 })),
      }),
      inTelegram,
    );

    expect(await screen.findByTestId("pay-amount")).toHaveTextContent("$40.00");
    expect(screen.getByText("Please transfer exactly this amount.")).toBeInTheDocument();
  });

  it("倒计时每秒刷新，归零后显示过期并隐藏上传入口", async () => {
    renderApp(
      PATH,
      runnerRoutes({ [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail({ deadlineAt: "2026-09-14T03:00:05Z" })) }),
      inTelegram,
    );

    expect(await screen.findByTestId("pay-countdown")).toHaveTextContent("00:05");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("pay-countdown")).toHaveTextContent("00:04");
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByTestId("pay-expired")).toHaveTextContent("The payment window has closed");
    expect(screen.queryByTestId("pay-countdown")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pay-upload-link")).not.toBeInTheDocument();
  });

  it("凭证审核中的订单跳回订单详情", async () => {
    const { router } = renderApp(
      PATH,
      runnerRoutes({ [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null })) }),
      inTelegram,
    );

    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
    expect(router.state.location.pathname).toBe(`/orders/${ORDER_NO}`);
  });
});
