import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createMemoryRouter } from "react-router";
import { vi } from "vitest";
import { ApiProvider } from "../api";
import { routes } from "../routes";

export type FetchHandler = (request: Request) => Promise<Response>;

/** 用真实路由表渲染应用；fetch 被替换为 handler，返回收到的请求列表 */
export function renderApp(path: string, handler: FetchHandler) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      return handler(request);
    }),
  );
  const i18n = initI18n("user");
  const api = createApiClient({ client: "user", baseUrl: "http://localhost/api", getLang: currentLang });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>,
  );
  return { ...view, router, requests };
}
