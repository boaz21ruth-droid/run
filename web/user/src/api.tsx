import type { ApiClient } from "@werun/api-client";
import { createContext, useContext, type ReactNode } from "react";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error("useApi 必须在 ApiProvider 内使用");
  }
  return client;
}
