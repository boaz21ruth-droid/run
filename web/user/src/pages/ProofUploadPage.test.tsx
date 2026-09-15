import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isFileField, readMultipartFields } from "@werun/api-client/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { inTelegram, orderDetail, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

const ORDER_NO = "WR7K2M9QXA";
const ORDER_PATH = `/api/app/orders/${ORDER_NO}`;
const SUBMIT_PATH = `/api/app/orders/${ORDER_NO}/proofs`;
const PATH = `/orders/${ORDER_NO}/proof`;

function receipt(name = "receipt.png", type = "image/png", size = 64): File {
  return new File([new Uint8Array(size)], name, { type });
}

function isSubmit(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === SUBMIT_PATH;
}

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

describe("ProofUploadPage", () => {
  it("金额默认带出应付；以 multipart 提交后进入订单详情", async () => {
    let submitted = false;
    const user = userEvent.setup();
    const { requests, router } = renderApp(
      PATH,
      runnerRoutes({
        [`GET ${ORDER_PATH}`]: () => jsonResponse(200, submitted ? orderDetail({ status: "PROOF_SUBMITTED", deadlineAt: null }) : orderDetail()),
        [`POST ${SUBMIT_PATH}`]: () => {
          submitted = true;
          return jsonResponse(201, { id: 301, proofNo: "PF8H2K4M6N", status: "SUBMITTED" });
        },
      }),
      inTelegram,
    );

    const fileInput = await screen.findByTestId("proof-file-input");
    expect(fileInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    expect(screen.getByTestId("proof-amount")).toHaveValue("39.99");
    expect(screen.getByTestId("proof-paid-at")).toHaveAttribute("type", "datetime-local");

    await user.upload(fileInput, receipt());
    await user.type(screen.getByTestId("proof-txn-ref"), "aba 7788 99");
    await user.click(screen.getByTestId("proof-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/orders/${ORDER_NO}`));
    const post = requests.find(isSubmit);
    expect(post).toBeDefined();
    expect(post!.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    const fields = await readMultipartFields(post!.clone());
    expect(fields.bankTxnRef).toBe("ABA778899");
    expect(fields.declaredAmountCents).toBe("3999");
    expect(fields.declaredPaidAt).toBeUndefined();
    // 注：这套 vitest(jsdom) + Node 环境下，multipart 请求体里的文件名/字节在这条兼容链路里不可靠
    // （见 @werun/api-client/testing 的 multipart.ts 顶部注释），这里只验证字段确实是文件、且类型正确。
    const file = fields.file;
    expect(isFileField(file)).toBe(true);
    expect(isFileField(file) && file.type).toBe("image/png");
    expect(await screen.findByTestId("order-reviewing")).toBeInTheDocument();
    expect(screen.getByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
  });

  it("文件超过 5 MB 时提示且不发请求", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(PATH, runnerRoutes({ [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail()) }), inTelegram);

    await user.upload(await screen.findByTestId("proof-file-input"), receipt("big.png", "image/png", 5 * 1024 * 1024 + 1));
    await user.type(screen.getByTestId("proof-txn-ref"), "ABA778899");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByText("The image must be 5 MB or smaller")).toBeInTheDocument();
    expect(requests.some(isSubmit)).toBe(false);
  });

  it("文件类型、交易号、金额不合规时逐项提示", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { requests } = renderApp(PATH, runnerRoutes({ [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail()) }), inTelegram);

    await user.upload(await screen.findByTestId("proof-file-input"), receipt("receipt.gif", "image/gif"));
    await user.type(screen.getByTestId("proof-txn-ref"), "ab 1");
    await user.clear(screen.getByTestId("proof-amount"));
    await user.type(screen.getByTestId("proof-amount"), "0");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByText("Only JPG, PNG or WebP images are accepted")).toBeInTheDocument();
    expect(screen.getByText("The transaction reference must be 4–64 characters, not counting spaces")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount above 0 with at most two decimals")).toBeInTheDocument();
    expect(requests.some(isSubmit)).toBe(false);
  });

  it("交易号已被使用：显示错误码文案与字段错误，停留在上传页", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(
      PATH,
      runnerRoutes({
        [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail()),
        [`POST ${SUBMIT_PATH}`]: () =>
          jsonResponse(409, {
            error: { code: "PROOF_TXN_REF_USED", message: "server text", fields: { bankTxnRef: "Already used by another proof" } },
          }),
      }),
      inTelegram,
    );

    await user.upload(await screen.findByTestId("proof-file-input"), receipt());
    await user.type(screen.getByTestId("proof-txn-ref"), "ABA778899");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByTestId("form-error")).toHaveTextContent(
      "This transaction reference has already been submitted. Check it and try again.",
    );
    expect(screen.getByText("Already used by another proof")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PATH);
  });

  it("订单已过期：提示过期并给出重新报名入口", async () => {
    const user = userEvent.setup();
    renderApp(
      PATH,
      runnerRoutes({
        [`GET ${ORDER_PATH}`]: () => jsonResponse(200, orderDetail()),
        [`POST ${SUBMIT_PATH}`]: () => jsonResponse(409, { error: { code: "ORDER_EXPIRED", message: "server text" } }),
      }),
      inTelegram,
    );

    await user.upload(await screen.findByTestId("proof-file-input"), receipt());
    await user.type(screen.getByTestId("proof-txn-ref"), "ABA778899");
    await user.click(screen.getByTestId("proof-submit"));

    expect(await screen.findByTestId("form-error")).toHaveTextContent("This order has expired. Please register again.");
    expect(screen.getByTestId("proof-reregister")).toHaveAttribute("href", "/events/phnom-penh-half-2026/register");
  });
});
