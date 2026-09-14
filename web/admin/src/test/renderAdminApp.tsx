import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createAdminApp } from "../bootstrap";
import { jsonResponse } from "./fixtures";

export type MockRoutes = Record<string, (request: Request) => Response | Promise<Response>>;

/** key 形如 "GET /api/admin/me"；未声明的请求返回 404，便于发现多余的调用 */
export function renderAdminApp(path: string, routes: MockRoutes) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      const key = `${request.method} ${new URL(request.url).pathname}`;
      const handler = routes[key];
      if (!handler) {
        return jsonResponse(404, { error: { code: "NOT_FOUND", message: `no mock for ${key}` } });
      }
      return handler(request);
    }),
  );
  const app = createAdminApp({ baseUrl: "http://localhost/api", memoryPath: path });
  const view = render(app.element);
  return { ...view, router: app.router, requests };
}
