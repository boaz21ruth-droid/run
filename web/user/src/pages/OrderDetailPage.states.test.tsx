import type { Schemas } from "@werun/api-client";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { inTelegram, orderDetail, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${btoa(text)}`),
}));

const ORDER_NO = "WR7K2M9QXA";
const ORDER_PATH = `/api/app/orders/${ORDER_NO}`;
const TICKETS = ["7K3M9Q2A4D6F8H1J3K5M7N9P2Q4R6S8T", "2Q4R6S8T7K3M9Q2A4D6F8H1J3K5M7N9P"];

function renderOrder(order: Schemas["OrderDetail"]) {
  return renderApp(`/orders/${ORDER_NO}`, runnerRoutes({ [`GET ${ORDER_PATH}`]: () => jsonResponse(200, order) }), inTelegram);
}

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

describe("OrderDetailPage 各状态面板", () => {
  it("待付款：显示倒计时，不显示其他状态面板", async () => {
    renderOrder(orderDetail());

    expect(await screen.findByTestId("order-countdown")).toBeInTheDocument();
    expect(screen.queryByTestId("order-reviewing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-reject-reason")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-ticket-qr")).not.toBeInTheDocument();
  });

  it("审核中：显示审核提示，没有付款、重传入口和倒计时", async () => {
    renderOrder(orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null }));

    expect(await screen.findByTestId("order-reviewing")).toHaveTextContent("Finance usually reviews it within 24 hours");
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-reupload")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-countdown")).not.toBeInTheDocument();
  });

  it("被驳回：显示原因码文案、说明与重传截止时间，重新上传指向上传页", async () => {
    renderOrder(
      orderDetail({
        status: "PROOF_REJECTED",
        deadlineAt: "2026-09-15T03:00:00Z",
        lastRejection: { code: "UNREADABLE", reason: "Amount is cut off", reviewedAt: "2026-09-14T03:00:00Z" },
      }),
    );

    const reason = await screen.findByTestId("order-reject-reason");
    expect(reason).toHaveTextContent("Screenshot unreadable");
    expect(reason).toHaveTextContent("Reason: Amount is cut off");
    expect(reason).toHaveTextContent("Upload a new proof by");
    expect(screen.getByTestId("order-reupload")).toHaveAttribute("href", `/orders/${ORDER_NO}/proof`);
    expect(screen.getByTestId("order-pay")).toBeInTheDocument();
  });

  it("已确认：每位参赛人一张参赛凭证二维码", async () => {
    const participants = orderDetail().participants.map((participant, i) => ({
      ...participant,
      registrationStatus: "CONFIRMED" as const,
      ticketCode: TICKETS[i],
    }));
    renderOrder(orderDetail({ status: "PAID", deadlineAt: null, paidAt: "2026-09-14T04:00:00Z", participants }));

    const qrs = await screen.findAllByTestId("order-ticket-qr");
    expect(qrs).toHaveLength(2);
    expect(qrs[0]).toHaveAttribute("src", `data:image/png;base64,${btoa(TICKETS[0]!)}`);
    expect(qrs[1]).toHaveAttribute("alt", "Race ticket for Lim Dara");
    expect(screen.getByText("Your registration is confirmed. Show the ticket below on race day.")).toBeInTheDocument();
  });

  it("已过期：显示过期说明与重新报名入口", async () => {
    renderOrder(orderDetail({ status: "EXPIRED", deadlineAt: null }));

    expect(await screen.findByText("This order has expired and the spots were released.")).toBeInTheDocument();
    expect(screen.getByTestId("order-register-again")).toHaveAttribute("href", "/events/phnom-penh-half-2026/register");
    expect(screen.queryByTestId("order-ticket-qr")).not.toBeInTheDocument();
  });

  it("已取消：只显示取消说明", async () => {
    renderOrder(orderDetail({ status: "CANCELLED", deadlineAt: null }));

    expect(await screen.findByText("This order was cancelled.")).toBeInTheDocument();
    expect(screen.queryByTestId("order-pay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("order-cancel")).not.toBeInTheDocument();
  });
});
