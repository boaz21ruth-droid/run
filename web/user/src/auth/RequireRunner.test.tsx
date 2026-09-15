import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes, jsonResponse, runnerSession } from "../test/fixtures";
import { renderRoutes } from "../test/renderApp";
import { RequireRunner } from "./RequireRunner";

const guarded = [{ path: "/", element: <RequireRunner><p>runner only</p></RequireRunner> }];

describe("RequireRunner", () => {
  it("没有 initData 时显示在 Telegram 中打开，链接指向机器人，不发请求", async () => {
    window.localStorage.setItem("werun.lang", "en");
    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", "werun_test_bot");

    const { requests } = renderRoutes(guarded, "/", apiRoutes({}), { initData: null });

    const panel = await screen.findByTestId("open-in-telegram");
    expect(panel).toHaveTextContent("Open in Telegram");
    expect(screen.getByRole("link", { name: "Open Telegram" })).toHaveAttribute("href", "https://t.me/werun_test_bot");
    expect(screen.queryByText("runner only")).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("没有配置机器人用户名时不显示链接", async () => {
    window.localStorage.setItem("werun.lang", "en");
    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", "");

    renderRoutes(guarded, "/", apiRoutes({}), { initData: null });

    await screen.findByTestId("open-in-telegram");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("登录成功后渲染受保护内容并保存令牌", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderRoutes(
      guarded,
      "/",
      apiRoutes({ "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")) }),
      { initData: "signed-init-data" },
    );

    expect(screen.getByRole("status")).toHaveTextContent("Checking your sign-in…");
    expect(await screen.findByText("runner only")).toBeInTheDocument();
    expect(await requests[0]!.clone().json()).toEqual({ initData: "signed-init-data" });
    expect(requests[0]!.headers.get("X-WeRun-Client")).toBeNull();
    expect(window.sessionStorage.getItem("werun.appToken")).toBe("tok-1");
    expect(window.sessionStorage.getItem("werun.appTokenExpiresAt")).toBe("2099-01-01T00:00:00Z");
  });

  it("initData 校验失败时显示在 Telegram 中打开", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderRoutes(
      guarded,
      "/",
      apiRoutes({
        "POST /api/app/auth/telegram": () =>
          jsonResponse(401, { error: { code: "TELEGRAM_AUTH_INVALID", message: "We couldn't verify your Telegram sign-in." } }),
      }),
      { initData: "expired-init-data" },
    );

    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem("werun.appToken")).toBeNull());
  });

  it("已有有效令牌时用 me 恢复登录", async () => {
    window.localStorage.setItem("werun.lang", "en");
    window.sessionStorage.setItem("werun.appToken", "stored-token");
    window.sessionStorage.setItem("werun.appTokenExpiresAt", "2099-01-01T00:00:00Z");

    const { requests } = renderRoutes(
      guarded,
      "/",
      apiRoutes({ "GET /api/app/me": () => jsonResponse(200, runnerSession().user) }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByText("runner only")).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer stored-token");
  });
});
