import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { saveToken } from "../auth/session";
import { apiRoutes, jsonResponse } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

const events = () => ({ "GET /api/events": () => jsonResponse(200, { items: [] }) });

describe("Layout 顶栏用户区", () => {
  it("浏览器模式未登录时显示登录入口，不显示「我的」", async () => {
    renderApp("/", apiRoutes(events()), { initData: null });

    expect(await screen.findByTestId("nav-login")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-me")).not.toBeInTheDocument();
  });

  it("浏览器模式已登录时「我的」链接显示显示名", async () => {
    saveToken("tok-1", "2099-01-01T00:00:00Z");
    renderApp(
      "/",
      apiRoutes({
        ...events(),
        "GET /api/app/me": () =>
          jsonResponse(200, {
            id: 1,
            telegramUserId: null,
            telegramUsername: null,
            phoneMasked: "+855***678",
            displayName: "Sok Dara",
            locale: "en",
          }),
      }),
      { initData: null },
    );

    const link = await screen.findByTestId("nav-me");
    expect(link).toHaveTextContent("Sok Dara");
    expect(link).toHaveAttribute("href", "/me");
    expect(screen.queryByTestId("nav-login")).not.toBeInTheDocument();
  });

  it("显示名为空时「我的」链接退回显示脱敏手机号", async () => {
    saveToken("tok-2", "2099-01-01T00:00:00Z");
    renderApp(
      "/",
      apiRoutes({
        ...events(),
        "GET /api/app/me": () =>
          jsonResponse(200, {
            id: 2,
            telegramUserId: null,
            telegramUsername: null,
            phoneMasked: "+855***678",
            displayName: "",
            locale: "en",
          }),
      }),
      { initData: null },
    );

    expect(await screen.findByTestId("nav-me")).toHaveTextContent("+855***678");
  });
});
