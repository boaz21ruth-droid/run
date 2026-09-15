import { screen, waitFor, within } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse, photographerMe } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";
import {
  ORDER_NO,
  approvedDetail,
  reviewerMe,
  proofDetail,
  queueItems,
  rejectedDetail,
  supportMe,
} from "./test/reviewFixtures";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

/** antd 表单交互关闭 pointer-events 检查，原因见 app.test.tsx */
function setupFormUser() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

/** 等 antd 弹窗里的表单项渲染出来 */
async function findField<T extends HTMLElement>(id: string): Promise<T> {
  return waitFor(() => {
    const element = document.querySelector<T>(`#${id}`);
    if (!element) {
      throw new Error(`#${id} 尚未渲染`);
    }
    return element;
  });
}

describe("凭证队列", () => {
  it("默认只请求待审凭证：超时行高亮、重复截图有标记，点击行进入详情", async () => {
    const { router, requests } = renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs": () => jsonResponse(200, { items: queueItems }),
      "GET /api/admin/proofs/301": () => jsonResponse(200, proofDetail),
    });

    const overdue = await screen.findByTestId("proof-row-PF8H2K4M6N");
    expect(overdue).toHaveAttribute("data-over-sla", "true");
    expect(within(overdue).getByText("Overdue")).toBeInTheDocument();
    expect(overdue).toHaveTextContent("$24.51");
    const duplicate = screen.getByTestId("proof-row-PF3J5L7P9R");
    expect(duplicate).toHaveAttribute("data-over-sla", "false");
    expect(within(duplicate).getByText("Duplicate screenshot")).toBeInTheDocument();
    const listRequest = requests.find((request) => new URL(request.url).pathname === "/api/admin/proofs");
    expect(new URL(listRequest!.url).searchParams.get("status")).toBe("SUBMITTED");
    expect(requests.filter((request) => new URL(request.url).pathname === "/api/admin/proofs")).toHaveLength(1);

    await setupFormUser().click(overdue);

    await waitFor(() => expect(router.state.location.pathname).toBe("/proofs/301"));
    expect(await screen.findByTestId("proof-status")).toHaveAttribute("data-status", "SUBMITTED");
  });

  it("菜单按权限显示凭证审核与订单", async () => {
    renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs": () => jsonResponse(200, { items: [] }),
    });
    expect(await screen.findByRole("menuitem", { name: /Payment review/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Orders/ })).toBeInTheDocument();
  });

  it("摄影师没有 proof_review：显示 403 且菜单不显示凭证审核", async () => {
    renderAdminApp("/proofs", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });
    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Payment review/ })).not.toBeInTheDocument();
  });
});

describe("凭证详情", () => {
  it("显示截图与申报信息；到账金额小于应付时通过按钮不可用并提示", async () => {
    renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, proofDetail),
    });

    const image = await screen.findByTestId("proof-image");
    expect(within(image).getByRole("img", { name: "Payment screenshot" })).toHaveAttribute("src", "/api/admin/files/88");
    expect(screen.getAllByText(ORDER_NO).length).toBeGreaterThan(0);
    expect(screen.getByText("SOKHA CHAN")).toBeInTheDocument();

    const user = setupFormUser();
    await user.click(screen.getByTestId("proof-approve-open"));
    const amount = await findField<HTMLInputElement>("approve_receivedUsd");
    expect(amount).toHaveValue("24.51");
    await waitFor(() => expect(screen.getByTestId("proof-approve-submit")).toBeEnabled());

    await user.clear(amount);
    await user.paste("24.50");

    await waitFor(() => expect(screen.getByTestId("proof-approve-submit")).toBeDisabled());
    expect(screen.getByTestId("proof-approve-too-low")).toHaveTextContent("$24.51");
  });

  it("按申报金额通过：请求体正确，成功后状态变为已通过并隐藏审核按钮", async () => {
    let approved = false;
    const { requests } = renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, approved ? approvedDetail : proofDetail),
      "POST /api/admin/proofs/301/approve": () => {
        approved = true;
        return jsonResponse(200, approvedDetail);
      },
    });

    const user = setupFormUser();
    await user.click(await screen.findByTestId("proof-approve-open"));
    await findField("approve_receivedUsd");
    await waitFor(() => expect(screen.getByTestId("proof-approve-submit")).toBeEnabled());
    await user.click(screen.getByTestId("proof-approve-submit"));

    await waitFor(() => expect(screen.getByTestId("proof-status")).toHaveAttribute("data-status", "APPROVED"));
    expect(screen.queryByTestId("proof-approve-open")).not.toBeInTheDocument();
    const post = requests.find((request) => request.method === "POST");
    expect(post?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await post?.clone().json()).toEqual({
      receivedAmountCents: 2451,
      receivedAt: "2026-09-14T02:55:00.000Z",
      note: null,
    });
  });

  it("驳回选「其他原因」时说明必填，填写后提交", async () => {
    let rejected = false;
    const { requests } = renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, reviewerMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, rejected ? rejectedDetail : proofDetail),
      "POST /api/admin/proofs/301/reject": () => {
        rejected = true;
        return jsonResponse(200, rejectedDetail);
      },
    });

    const user = setupFormUser();
    await user.click(await screen.findByTestId("proof-reject-open"));
    await user.click(await findField("reject_rejectCode"));
    await user.click(await screen.findByTitle("Other"));
    await user.click(screen.getByTestId("proof-reject-submit"));

    expect(await screen.findByText("Explain the reason when choosing Other")).toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.click(await findField("reject_rejectReason"));
    await user.paste("Paid to a personal account");
    await user.click(screen.getByTestId("proof-reject-submit"));

    await waitFor(() => expect(screen.getByTestId("proof-status")).toHaveAttribute("data-status", "REJECTED"));
    const post = requests.find((request) => request.method === "POST");
    expect(new URL(post!.url).pathname).toBe("/api/admin/proofs/301/reject");
    expect(await post!.clone().json()).toEqual({ rejectCode: "OTHER", rejectReason: "Paid to a personal account" });
  });

  it("SUPPORT 只读：能看详情，看不到通过与驳回按钮", async () => {
    renderAdminApp("/proofs/301", {
      "GET /api/admin/me": () => jsonResponse(200, supportMe),
      "GET /api/admin/proofs/301": () => jsonResponse(200, proofDetail),
    });

    expect(await screen.findByTestId("proof-status")).toHaveAttribute("data-status", "SUBMITTED");
    expect(screen.getByTestId("proof-image")).toBeInTheDocument();
    expect(screen.queryByTestId("proof-approve-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("proof-reject-open")).not.toBeInTheDocument();
  });
});
