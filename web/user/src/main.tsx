import "@werun/tokens/tokens.css";
import "@werun/tokens/fonts.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createBrowserRouter } from "react-router";
import { ApiProvider } from "./api";
import { routes } from "./routes";
import { initTelegram } from "./telegram/telegram";

const i18n = initI18n("user");
const api = createApiClient({ client: "user", getLang: currentLang });
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});
const router = createBrowserRouter(routes);

initTelegram(router).catch((error: unknown) => {
  // SDK 加载失败不影响网页本身可用
  console.error(error);
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html 缺少 #root 节点");
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>
  </StrictMode>,
);
