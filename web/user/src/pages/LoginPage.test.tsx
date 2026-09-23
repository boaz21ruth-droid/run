import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { apiRoutes, jsonResponse, runnerSession } from "../test/fixtures";
import { renderRoutes } from "../test/renderApp";
import { LoginPage } from "./LoginPage";

const routes = [
  { path: "/", element: <p>home page</p> },
  { path: "/login", element: <LoginPage /> },
  { path: "/orders", element: <p>orders page</p> },
  { path: "/events/abc", element: <p>event page</p> },
];

/** 走完发码 + 验证码的完整流程，返回登录成功后落地的 router */
async function loginFrom(nextRaw: string | undefined) {
  const user = userEvent.setup();
  const path = nextRaw === undefined ? "/login" : `/login?next=${encodeURIComponent(nextRaw)}`;
  const { router } = renderRoutes(
    routes,
    path,
    apiRoutes({
      "POST /api/app/auth/phone/request": () =>
        jsonResponse(200, { expiresInSeconds: 300, resendAfterSeconds: 60, channel: "telegram" }),
      "POST /api/app/auth/phone/verify": () => jsonResponse(200, runnerSession("tok")),
    }),
    { initData: null },
  );

  await user.type(screen.getByTestId("login-phone"), "12345678");
  await user.click(screen.getByTestId("login-send"));
  await screen.findByTestId("login-code");
  await user.type(screen.getByTestId("login-code"), "123456");
  await user.click(screen.getByTestId("login-verify"));

  return router;
}

describe("LoginPage", () => {
  it("发码后出现验证码输入并倒计时；验证成功后跳转 next", async () => {
    const user = userEvent.setup();
    let requestBody: unknown;
    let verifyBody: unknown;
    const { router } = renderRoutes(
      routes,
      "/login?next=%2Forders",
      apiRoutes({
        "POST /api/app/auth/phone/request": async (request) => {
          requestBody = await request.clone().json();
          return jsonResponse(200, { expiresInSeconds: 300, resendAfterSeconds: 60, channel: "telegram" });
        },
        "POST /api/app/auth/phone/verify": async (request) => {
          verifyBody = await request.clone().json();
          return jsonResponse(200, runnerSession("tok"));
        },
      }),
      { initData: null },
    );

    await user.type(screen.getByTestId("login-phone"), "12345678");
    await user.click(screen.getByTestId("login-send"));

    await waitFor(() => expect(requestBody).toEqual({ phone: "+85512345678" }));
    await screen.findByTestId("login-code");
    expect(screen.getByTestId("login-resend")).toBeDisabled();

    await user.type(screen.getByTestId("login-code"), "123456");
    await user.click(screen.getByTestId("login-verify"));

    await waitFor(() => expect(verifyBody).toEqual({ phone: "+85512345678", code: "123456" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/orders"));
  });

  it("显示服务端错误文案", async () => {
    const user = userEvent.setup();
    renderRoutes(
      routes,
      "/login",
      apiRoutes({
        "POST /api/app/auth/phone/request": () =>
          jsonResponse(422, { error: { code: "OTP_PHONE_NOT_ON_TELEGRAM", message: "这个手机号没有注册 Telegram" } }),
      }),
      { initData: null },
    );

    await user.type(screen.getByTestId("login-phone"), "12345678");
    await user.click(screen.getByTestId("login-send"));

    expect(await screen.findByRole("alert")).toHaveTextContent("没有注册 Telegram");
  });

  it("next 用反斜杠伪装同源路径时登录后停在首页", async () => {
    const router = await loginFrom("/\\evil.com");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("next 是协议相对地址时登录后停在首页", async () => {
    const router = await loginFrom("//evil.com");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("next 是绝对外部地址时登录后停在首页", async () => {
    const router = await loginFrom("https://evil.com");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("next 是 javascript 伪协议时登录后停在首页", async () => {
    const router = await loginFrom("javascript:alert(1)");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("next 带查询串的同源路径时精确跳转到该路径", async () => {
    const router = await loginFrom("/events/abc?x=1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/events/abc"));
    expect(router.state.location.search).toBe("?x=1");
  });
});
