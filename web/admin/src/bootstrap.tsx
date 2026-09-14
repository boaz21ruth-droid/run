import { QueryClient } from "@tanstack/react-query";
import { createApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import { RouterProvider, createBrowserRouter, createMemoryRouter } from "react-router";
import { AppProviders } from "./providers/AppProviders";
import { routes } from "./routes";

type AppRouter = ReturnType<typeof createBrowserRouter>;

export interface AdminAppOptions {
  /** 默认 "/api"；测试中传绝对地址 */
  baseUrl?: string;
  /** 传入时使用内存路由（测试），否则使用浏览器路由 */
  memoryPath?: string;
}

export function createAdminApp(options: AdminAppOptions = {}) {
  const i18n = initI18n("admin");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: options.memoryPath ? false : 1 } },
  });

  let router: AppRouter | null = null;
  const api = createApiClient({
    client: "admin",
    baseUrl: options.baseUrl,
    getLang: currentLang,
    onUnauthorized: () => {
      const pathname = router?.state.location.pathname;
      if (router && pathname !== "/login") {
        void router.navigate("/login", { replace: true, state: { from: pathname } });
      }
    },
  });

  router = options.memoryPath
    ? createMemoryRouter(routes, { initialEntries: [options.memoryPath] })
    : createBrowserRouter(routes);

  const element = (
    <AppProviders i18n={i18n} api={api} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );

  return { i18n, api, queryClient, router, element };
}
