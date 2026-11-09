import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NonIndexRouteObject, RouteObject } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { saveToken } from "../auth/session";
import { apiRoutes, jsonResponse } from "../test/fixtures";
import { RouteErrorPage } from "../pages/RouteErrorPage";
import { routes } from "../routes";
import { renderApp, renderRoutes } from "../test/renderApp";

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

describe("Layout 底部标签栏", () => {
  it("渲染与顶栏相同的目的地，带 aria-label，并标记当前页", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events", apiRoutes(events()), { initData: null });

    const tabbar = await screen.findByTestId("tabbar");
    expect(tabbar.tagName).toBe("NAV");
    expect(tabbar).toHaveAttribute("aria-label", "Main navigation");
    const links = within(tabbar).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/", "/events", "/orders", "/profiles"]);
    expect(links.map((link) => link.textContent)).toEqual(["Home", "Events", "My events", "Runners"]);
    // 图标是内联描边 SVG，对读屏隐藏
    for (const link of links) {
      const svg = link.querySelector("svg");
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("stroke", "currentColor");
    }

    expect(within(tabbar).getByTestId("tab-events")).toHaveAttribute("aria-current", "page");
    expect(within(tabbar).getByTestId("tab-home")).not.toHaveAttribute("aria-current");
  });

  it("点击标签切换路由后 aria-current 跟着移动", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const user = userEvent.setup();
    const { router } = renderApp("/", apiRoutes(events()), { initData: null });

    const tabbar = await screen.findByTestId("tabbar");
    expect(within(tabbar).getByTestId("tab-home")).toHaveAttribute("aria-current", "page");
    await user.click(within(tabbar).getByTestId("tab-events"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/events"));
    expect(within(tabbar).getByTestId("tab-events")).toHaveAttribute("aria-current", "page");
    expect(within(tabbar).getByTestId("tab-home")).not.toHaveAttribute("aria-current");
  });
});

describe("Layout 路由切换", () => {
  it("document.title 换成本地化的页面标题，焦点移到 <main>", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { router } = renderApp("/", apiRoutes(events()), { initData: null });

    await screen.findByTestId("tabbar");
    await waitFor(() => expect(document.title).toBe("WeRun"));
    // 首次进入不抢焦点
    expect(screen.getByRole("main")).not.toHaveFocus();

    await act(() => router.navigate("/events"));

    await waitFor(() => expect(document.title).toBe("All events · WeRun"));
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(main).toHaveFocus();
  });

  it("切换语言后标题跟着换语言", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const user = userEvent.setup();
    renderApp("/events", apiRoutes(events()), { initData: null });

    await waitFor(() => expect(document.title).toBe("All events · WeRun"));
    await user.click(screen.getByTestId("lang-switch-zh"));
    await waitFor(() => expect(document.title).toBe("全部赛事 · WeRun"));
  });
});

describe("根路由 errorElement", () => {
  it("子路由渲染抛错时显示本地化出错页，带回首页链接与重新加载按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("boom");
    }
    const root = routes[0] as NonIndexRouteObject;
    const reload = vi.fn();
    // 真实根路由的 errorElement 就是 RouteErrorPage；这里只换掉 reload，以便断言按钮动作
    expect(root.errorElement).toBeTruthy();
    const withBoom: RouteObject[] = [
      {
        ...root,
        errorElement: <RouteErrorPage reload={reload} />,
        children: [...(root.children ?? []), { path: "boom", element: <Boom /> }],
      },
    ];

    renderRoutes(withBoom, "/boom", apiRoutes(events()), { initData: null });

    const page = await screen.findByTestId("route-error");
    expect(within(page).getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong");
    expect(within(page).getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    await userEvent.setup().click(within(page).getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
    expect(document.title).toBe("Something went wrong · WeRun");
    consoleError.mockRestore();
  });

  it("真实路由表的根 errorElement 接住子路由错误", async () => {
    window.localStorage.setItem("werun.lang", "zh");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("boom");
    }
    const root = routes[0] as NonIndexRouteObject;
    renderRoutes([{ ...root, children: [{ path: "boom", element: <Boom /> }] }], "/boom", apiRoutes(events()), { initData: null });

    expect(await screen.findByRole("heading", { name: "页面出错了" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
