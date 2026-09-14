import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abaAccount,
  financeMe,
  jsonResponse,
  opsMe,
  photographerMe,
  publishedEvent,
} from "../test/fixtures";
import { fillField, replaceField, setupFormUser } from "../test/form";
import { isFileField, readMultipartFields } from "../test/multipart";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function findRequest(requests: Request[], method: string, pathname: string): Request | undefined {
  return requests.find((request) => request.method === method && new URL(request.url).pathname === pathname);
}

function qrFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });
}

async function fillAccountForm(user: ReturnType<typeof setupFormUser>) {
  await fillField(user, "paymentAccount_name", "ABA USD 主收款户");
  await fillField(user, "paymentAccount_accountName", "WERUN SPORTS CO LTD");
  await fillField(user, "paymentAccount_accountNoMasked", "*** 123");
}

describe("收款账户页", () => {
  it("FINANCE 新建收款账户：以 multipart 上传二维码", async () => {
    let created = false;
    const { requests } = renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [publishedEvent] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: created ? [abaAccount] : [] }),
      "POST /api/admin/payment-accounts": () => {
        created = true;
        return jsonResponse(201, abaAccount);
      },
    });
    const user = setupFormUser();

    expect(await screen.findByRole("menuitem", { name: /Payment accounts/ })).toBeInTheDocument();
    await user.click(await screen.findByTestId("payment-account-create"));
    await fillAccountForm(user);
    await user.upload(screen.getByTestId("payment-account-qr-input"), qrFile());
    await user.click(screen.getByTestId("payment-account-submit"));

    const row = await screen.findByTestId("payment-account-row-5");
    expect(within(row).getByText("*** 123")).toBeInTheDocument();
    const post = findRequest(requests, "POST", "/api/admin/payment-accounts");
    expect(post?.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(post?.headers.get("X-WeRun-Client")).toBe("admin");
    // 注：这套 vitest(jsdom) + Node 环境下，Request.formData() 解码含 File 字段的请求体会抛出
    // webidl 断言错误（vitest 的 jsdom 兼容层构造请求体本身没问题，问题出在事后解码——见
    // src/test/multipart.ts 顶部注释），所以改用手工解析 multipart 原始字节；同样的原因，
    // 二维码内容在这条兼容链路里会被清空，因此这里只能验证字段名与 Content-Type，验证不了字节数，
    // 完整的二维码大小/内容校验见后端 payment_accounts_http_test.go 的 TestPaymentAccountsHTTP。
    const fields = await readMultipartFields(post!);
    expect(fields.name).toBe("ABA USD 主收款户");
    expect(fields.provider).toBe("ABA");
    expect(fields.accountName).toBe("WERUN SPORTS CO LTD");
    expect(fields.accountNoMasked).toBe("*** 123");
    expect(fields.scope).toBe("REGISTRATION");
    expect(fields.eventId).toBe("");
    expect(fields.active).toBe("true");
    expect(isFileField(fields.qr)).toBe(true);
    if (isFileField(fields.qr)) {
      expect(fields.qr.type).toBe("image/png");
    }
  });

  it("新建时没有选择二维码：提示并且不提交", async () => {
    const { requests } = renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [] }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("payment-account-create"));
    await fillAccountForm(user);
    await user.click(screen.getByTestId("payment-account-submit"));

    expect(await screen.findByText("Upload the payment QR code")).toBeInTheDocument();
    expect(findRequest(requests, "POST", "/api/admin/payment-accounts")).toBeUndefined();
  });

  it("服务端返回文件太大时显示错误", async () => {
    renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [] }),
      "POST /api/admin/payment-accounts": () =>
        jsonResponse(413, { error: { code: "FILE_TOO_LARGE", message: "The file is too large. The limit is 2 MB." } }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("payment-account-create"));
    await fillAccountForm(user);
    await user.upload(screen.getByTestId("payment-account-qr-input"), qrFile());
    await user.click(screen.getByTestId("payment-account-submit"));

    expect(await screen.findByText("The file is too large. The limit is 2 MB.")).toBeInTheDocument();
  });

  it("编辑时不选新图片：请求体不带 qr", async () => {
    const { requests } = renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, financeMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [publishedEvent] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [abaAccount] }),
      "PUT /api/admin/payment-accounts/5": () => jsonResponse(200, { ...abaAccount, name: "ABA USD 备用" }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("payment-account-edit-5"));
    await replaceField(user, "paymentAccount_name", "ABA USD 备用");
    await user.click(screen.getByTestId("payment-account-submit"));

    expect(await screen.findByText("Payment account saved")).toBeInTheDocument();
    const fields = await readMultipartFields(findRequest(requests, "PUT", "/api/admin/payment-accounts/5")!);
    expect(fields.name).toBe("ABA USD 备用");
    expect(fields.qr).toBeUndefined();
  });

  it("OPS 只读：能看列表与二维码，没有新建与编辑按钮", async () => {
    renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "GET /api/admin/payment-accounts": () => jsonResponse(200, { items: [abaAccount] }),
    });

    const row = await screen.findByTestId("payment-account-row-5");
    expect(within(row).getByRole("img")).toHaveAttribute("src", "/api/files/88");
    expect(within(row).getByText("All events")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-account-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-account-edit-5")).not.toBeInTheDocument();
  });

  it("没有权限的角色：菜单不显示，直接访问显示 403", async () => {
    renderAdminApp("/payment-accounts", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Payment accounts/ })).not.toBeInTheDocument();
  });
});
