import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, createApiClient, unwrap, type ApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, type createMemoryRouter } from "react-router";
import { ApiProvider } from "./api";
import { AuthProvider } from "./auth/AuthProvider";
import { AuthController } from "./auth/controller";
import { readToken, resolveInitData } from "./auth/session";

/** createBrowserRouter 与 createMemoryRouter 返回同一类型 */
type DataRouter = ReturnType<typeof createMemoryRouter>;

export interface UserAppOptions {
  router: DataRouter;
  baseUrl?: string;
  /** 非 401 错误的查询重试次数，默认 1；测试传 0 */
  retry?: number;
  /** 默认按 Telegram → 开发登录参数的顺序取 initData */
  resolveInitData?: () => Promise<string | null>;
}

export interface UserApp {
  element: ReactElement;
  api: ApiClient;
  auth: AuthController;
  queryClient: QueryClient;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** 组装用户端：接口客户端、登录状态、查询缓存与 Provider。main.tsx 与测试共用。 */
export function createUserApp(options: UserAppOptions): UserApp {
  const i18n = initI18n("user");

  const auth = new AuthController({
    resolveInitData: options.resolveInitData ?? (() => resolveInitData()),
    login: async (initData) => unwrap(await api.POST("/app/auth/telegram", { body: { initData } })),
    me: async () => unwrap(await api.GET("/app/me")),
    logout: async () => {
      unwrap(await api.POST("/app/auth/logout"));
    },
  });

  const api = createApiClient({
    client: "user",
    baseUrl: options.baseUrl,
    getLang: currentLang,
    getAuthToken: () => readToken(),
    onUnauthorized: () => auth.handleUnauthorized(),
  });

  // 401 的查询：等这次 401 触发的重新登录结束，成功就重置并重新请求一次；同一查询再次 401 时放弃。
  const retriedAfterRelogin = new Set<string>();
  const maxRetries = options.retry ?? 1;
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!isUnauthorized(error)) {
          return;
        }
        if (retriedAfterRelogin.has(query.queryHash)) {
          retriedAfterRelogin.delete(query.queryHash);
          return;
        }
        retriedAfterRelogin.add(query.queryHash);
        void auth.lastRelogin().then((ok) => {
          if (ok) {
            void queryClient.resetQueries({ queryKey: query.queryKey, exact: true });
          } else {
            retriedAfterRelogin.delete(query.queryHash);
          }
        });
      },
      onSuccess: (_data, query) => {
        retriedAfterRelogin.delete(query.queryHash);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: (failureCount, error) => !isUnauthorized(error) && failureCount < maxRetries,
      },
    },
  });

  const element = (
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider controller={auth}>
            <RouterProvider router={options.router} />
          </AuthProvider>
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>
  );
  return { element, api, auth, queryClient };
}
