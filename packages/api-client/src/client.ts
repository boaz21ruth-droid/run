import createClient, { type Client, type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  client: "user" | "admin";
  baseUrl?: string;
  getLang: () => string;
  /** 跑者令牌；返回非空串时设置 Authorization: Bearer <token> */
  getAuthToken?: () => string | null;
  onUnauthorized?: () => void;
}

function werunMiddleware(options: ApiClientOptions): Middleware {
  return {
    onRequest({ request }) {
      request.headers.set("Accept-Language", options.getLang());
      if (options.client === "admin") {
        request.headers.set("X-WeRun-Client", "admin");
      }
      const token = options.getAuthToken?.();
      if (token) {
        request.headers.set("Authorization", `Bearer ${token}`);
      }
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) {
        options.onUnauthorized?.();
      }
      return undefined;
    },
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "/api",
    credentials: "include",
  });
  client.use(werunMiddleware(options));
  return client;
}
