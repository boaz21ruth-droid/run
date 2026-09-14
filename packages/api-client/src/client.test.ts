import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, UNEXPECTED_RESPONSE, createApiClient, unwrap } from "./index";

const BASE_URL = "http://localhost/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(respond: (request: Request) => Response) {
  const fetchMock = vi.fn(async (request: Request) => respond(request));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function firstRequest(fetchMock: ReturnType<typeof stubFetch>): Request {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("fetch 没有被调用");
  }
  return call[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient", () => {
  it("后台客户端带语言、客户端标识并携带 Cookie", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "km" });

    const result = await client.GET("/admin/events");

    expect(unwrap(result)).toEqual({ items: [] });
    const request = firstRequest(fetchMock);
    expect(request.url).toBe("http://localhost/api/admin/events");
    expect(request.headers.get("Accept-Language")).toBe("km");
    expect(request.headers.get("X-WeRun-Client")).toBe("admin");
    expect(request.credentials).toBe("include");
  });

  it("用户端客户端不带 X-WeRun-Client", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    const client = createApiClient({ client: "user", baseUrl: BASE_URL, getLang: () => "zh" });

    await client.GET("/events");

    const request = firstRequest(fetchMock);
    expect(request.headers.get("X-WeRun-Client")).toBeNull();
    expect(request.headers.get("Accept-Language")).toBe("zh");
  });

  it("每次请求都读取当前语言", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    let lang = "en";
    const client = createApiClient({ client: "user", baseUrl: BASE_URL, getLang: () => lang });

    await client.GET("/events");
    lang = "km";
    await client.GET("/events");

    expect(fetchMock.mock.calls[0]![0].headers.get("Accept-Language")).toBe("en");
    expect(fetchMock.mock.calls[1]![0].headers.get("Accept-Language")).toBe("km");
  });

  it("按 openapi 路径参数拼接地址并使用正确的方法", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, {
        id: 42,
        slug: "phnom-penh-half-2026",
        eventType: "RACE",
        organizerType: "OFFICIAL",
        name: { en: "Phnom Penh Half Marathon 2026" },
        city: "Phnom Penh",
        raceDate: "2026-11-15",
        status: "PUBLISHED",
        publicVisible: true,
        publishedAt: "2026-09-14T03:00:00Z",
        categories: [],
      }),
    );
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    await client.POST("/admin/events/{id}/publish", { params: { path: { id: 42 } } });

    const request = firstRequest(fetchMock);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/admin/events/42/publish");
  });

  it("收到 401 时调用 onUnauthorized", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Please sign in" } }));
    const onUnauthorized = vi.fn();
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en", onUnauthorized });

    const result = await client.GET("/admin/me");

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(() => unwrap(result)).toThrow(ApiError);
  });
});

describe("unwrap", () => {
  it("把约定的错误响应转换为带错误码和字段的 ApiError", async () => {
    stubFetch(() =>
      jsonResponse(422, {
        error: { code: "VALIDATION_FAILED", message: "Check the form", fields: { slug: "Required" } },
      }),
    );
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    const result = await client.POST("/admin/events", {
      body: {
        slug: "",
        eventType: "RACE",
        organizerType: "OFFICIAL",
        name: { zh: "金边半程马拉松", en: "Phnom Penh Half Marathon", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ" },
        city: "Phnom Penh",
        raceDate: "2026-11-15",
        categories: [],
      },
    });

    let caught: unknown;
    try {
      unwrap(result);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("VALIDATION_FAILED");
    expect(apiError.message).toBe("Check the form");
    expect(apiError.fields).toEqual({ slug: "Required" });
  });

  it("响应不是约定格式时使用 UNEXPECTED_RESPONSE", async () => {
    stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }));
    const client = createApiClient({ client: "user", baseUrl: BASE_URL, getLang: () => "en" });

    const result = await client.GET("/events");

    expect(() => unwrap(result)).toThrow(
      expect.objectContaining({ status: 502, code: UNEXPECTED_RESPONSE, fields: {} }),
    );
  });

  it("204 响应返回 undefined", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    const result = await client.POST("/admin/auth/logout");

    expect(unwrap(result)).toBeUndefined();
  });
});
