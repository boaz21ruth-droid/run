import { render } from "@testing-library/react";
import { createMemoryRouter, type RouteObject } from "react-router";
import { vi } from "vitest";
import { createUserApp } from "../bootstrap";
import { routes } from "../routes";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface RenderAppOptions {
  /** 模拟 Telegram 提供的 initData；为空时跑者处于未登录状态 */
  initData?: string | null;
}

/** 用给定路由表渲染完整应用；fetch 被替换为 handler，返回收到的请求列表 */
export function renderRoutes(routeObjects: RouteObject[], path: string, handler: FetchHandler, options: RenderAppOptions = {}) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      return handler(request);
    }),
  );
  // 带 initData 的用例模拟在 Telegram Mini App 中打开；没有传 initData 的用例保持地址不变（默认不带 tgWebAppData，浏览器模式）
  if (options.initData) {
    window.location.hash = "#tgWebAppData=test";
  }
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  const app = createUserApp({
    router,
    baseUrl: "http://localhost/api",
    retry: 0,
    resolveInitData: async () => options.initData ?? null,
  });
  const view = render(app.element);
  return { ...view, router, requests, queryClient: app.queryClient, auth: app.auth };
}

/** 用真实路由表渲染应用 */
export function renderApp(path: string, handler: FetchHandler, options: RenderAppOptions = {}) {
  return renderRoutes(routes, path, handler, options);
}
