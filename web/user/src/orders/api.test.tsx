import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { inTelegram, orderDetail, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { REVIEW_POLL_MS, orderRefetchInterval } from "./api";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${btoa(text)}`),
}));

const ORDER_NO = "WR7K2M9QXA";

describe("orderRefetchInterval", () => {
  it("只有凭证审核中（PROOF_SUBMITTED）每 15 秒轮询", () => {
    expect(REVIEW_POLL_MS).toBe(15_000);
    expect(orderRefetchInterval("PROOF_SUBMITTED")).toBe(15_000);
    for (const status of ["PENDING_PAYMENT", "PROOF_REJECTED", "PAID", "EXPIRED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"] as const) {
      expect(orderRefetchInterval(status)).toBe(false);
    }
    expect(orderRefetchInterval(undefined)).toBe(false);
  });
});

describe("订单详情轮询", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("审核中每 15 秒刷新一次，审核通过后停止轮询", async () => {
    // shouldAdvanceTime：findBy* 的轮询照常推进，同时可以手动快进 15 秒
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem("werun.lang", "en");
    const responses = [orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null }), orderDetail({ status: "PAID", deadlineAt: null })];
    let fetches = 0;
    renderApp(
      `/orders/${ORDER_NO}`,
      runnerRoutes({
        [`GET /api/app/orders/${ORDER_NO}`]: () => {
          const body = responses[Math.min(fetches, responses.length - 1)]!;
          fetches += 1;
          return jsonResponse(200, body);
        },
      }),
      inTelegram,
    );

    expect(await screen.findByTestId("order-reviewing")).toBeInTheDocument();
    expect(fetches).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(REVIEW_POLL_MS));
    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PAID");
    expect(fetches).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(REVIEW_POLL_MS * 3));
    expect(fetches).toBe(2);
  });
});
