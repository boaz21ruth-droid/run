import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@werun/api-client";
import type { i18n as I18n } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ApiProvider } from "../api";
import { AntdProvider } from "./AntdProvider";

interface AppProvidersProps {
  i18n: I18n;
  api: ApiClient;
  queryClient: QueryClient;
  children: ReactNode;
}

export function AppProviders({ i18n, api, queryClient, children }: AppProvidersProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <AntdProvider>{children}</AntdProvider>
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>
  );
}
