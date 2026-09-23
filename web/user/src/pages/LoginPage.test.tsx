import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { apiRoutes, jsonResponse, runnerSession } from "../test/fixtures";
import { renderRoutes } from "../test/renderApp";
import { LoginPage } from "./LoginPage";

const routes = [
  { path: "/login", element: <LoginPage /> },
  { path: "/orders", element: <p>orders page</p> },
];

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
});
