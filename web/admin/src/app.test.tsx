import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, draftEvent, jsonResponse, opsMe, photographerMe, unauthenticated } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

/** 按 antd 生成的 id 填写除时间外的必填字段；startAt/cutoffAt 由各测试按需单独填写 */
async function fillMinimalEventForm(): Promise<void> {
  const byId = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
  await userEvent.type(byId("event_slug"), "phnom-penh-half-2026");
  await userEvent.type(byId("event_name_zh"), "金边半程马拉松 2026");
  await userEvent.type(byId("event_name_en"), "Phnom Penh Half Marathon 2026");
  await userEvent.type(byId("event_name_km"), "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ");
  await userEvent.type(byId("event_city"), "Phnom Penh");
  // 用 tab 让输入的日期失焦确认，避免在表单内按 Enter 触发原生隐式提交
  await userEvent.type(byId("event_raceDate"), "2026-11-15");
  await userEvent.tab();
  await userEvent.type(byId("event_categories_0_code"), "21K");
  await userEvent.type(byId("event_categories_0_name_zh"), "半程");
  await userEvent.type(byId("event_categories_0_name_en"), "Half marathon");
  await userEvent.type(byId("event_categories_0_name_km"), "ពាក់កណ្ដាល");
  await userEvent.type(byId("event_categories_0_distanceM"), "21097");
  await userEvent.type(byId("event_categories_0_capacity"), "800");
}

describe("登录", () => {
  it("未登录访问赛事列表时跳转到登录页", async () => {
    const { router } = renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(401, unauthenticated),
    });

    expect(await screen.findByTestId("login-username")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("登录成功后回到原来要访问的页面", async () => {
    let signedIn = false;
    const { router, requests } = renderAdminApp("/events", {
      "GET /api/admin/me": () => (signedIn ? jsonResponse(200, opsMe) : jsonResponse(401, unauthenticated)),
      "POST /api/admin/auth/login": () => {
        signedIn = true;
        return jsonResponse(200, opsMe);
      },
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
    });

    await userEvent.type(await screen.findByTestId("login-username"), "ops.chan");
    await userEvent.type(screen.getByTestId("login-password"), "correct-horse-battery");
    await userEvent.click(screen.getByTestId("login-submit"));

    expect(await screen.findByRole("heading", { name: "Events" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events");
    const loginRequest = requests.find((request) => request.method === "POST");
    expect(loginRequest?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await loginRequest?.clone().json()).toEqual({ username: "ops.chan", password: "correct-horse-battery" });
  });
});

describe("权限", () => {
  it("摄影师没有赛事权限：菜单不显示赛事，直接访问显示 403", async () => {
    renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Events/ })).not.toBeInTheDocument();
  });

  it("ADMIN 只读：能看列表，看不到新建与发布按钮", async () => {
    renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
    });

    expect(await screen.findByText("Phnom Penh Half Marathon 2026")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Events/ })).toBeInTheDocument();
    expect(screen.queryByTestId("event-create-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("event-publish-phnom-penh-half-2026")).not.toBeInTheDocument();
  });

  it("ADMIN 直接访问新建页显示 403", async () => {
    renderAdminApp("/events/new", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
  });
});

describe("赛事列表", () => {
  it("OPS 发布草稿赛事后列表刷新为已发布", async () => {
    let published = false;
    const publishedEvent = { ...draftEvent, status: "PUBLISHED", publicVisible: true, publishedAt: "2026-09-14T03:00:00Z" };
    const { requests } = renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [published ? publishedEvent : draftEvent] }),
      "POST /api/admin/events/7/publish": () => {
        published = true;
        return jsonResponse(200, publishedEvent);
      },
    });

    expect(await screen.findByTestId("event-create-button")).toBeInTheDocument();
    await userEvent.click(await screen.findByTestId("event-publish-phnom-penh-half-2026"));

    await waitFor(() => {
      expect(screen.queryByTestId("event-publish-phnom-penh-half-2026")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Published")).toBeInTheDocument();
    const publishRequest = requests.find((request) => request.method === "POST");
    expect(publishRequest?.headers.get("X-WeRun-Client")).toBe("admin");
  });

  it("切换语言后页面文案与 html lang 同步", async () => {
    renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
    });

    await screen.findByTestId("event-create-button");
    await userEvent.click(screen.getByTestId("lang-switch-zh"));

    expect(document.documentElement.lang).toBe("zh");
    expect(await screen.findByRole("heading", { name: "赛事管理" })).toBeInTheDocument();
  });
});

describe("新建赛事", () => {
  it("OPS 填表提交：请求体字段形状正确，成功后回到列表页", async () => {
    const createdEvent = { ...draftEvent, id: 42 };
    const { router, requests } = renderAdminApp("/events/new", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
      "POST /api/admin/events": () => jsonResponse(201, createdEvent),
    });

    await screen.findByTestId("event-form-submit");
    await fillMinimalEventForm();
    const byId = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
    await userEvent.type(byId("event_categories_0_startAt"), "2026-11-15 06:00");
    await userEvent.tab();
    await userEvent.type(byId("event_categories_0_cutoffAt"), "2026-11-15 09:00");
    await userEvent.tab();

    await userEvent.click(screen.getByTestId("event-form-submit"));

    expect(await screen.findByRole("heading", { name: "Events" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events");

    const createRequest = requests.find(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/api/admin/events",
    );
    expect(createRequest?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await createRequest?.clone().json()).toEqual({
      slug: "phnom-penh-half-2026",
      eventType: "RACE",
      organizerType: "OFFICIAL",
      name: { zh: "金边半程马拉松 2026", en: "Phnom Penh Half Marathon 2026", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ" },
      city: "Phnom Penh",
      raceDate: "2026-11-15",
      categories: [
        {
          code: "21K",
          name: { zh: "半程", en: "Half marathon", km: "ពាក់កណ្ដាល" },
          distanceM: 21097,
          capacity: 800,
          startAt: dayjs("2026-11-15 06:00", "YYYY-MM-DD HH:mm").toISOString(),
          cutoffAt: dayjs("2026-11-15 09:00", "YYYY-MM-DD HH:mm").toISOString(),
        },
      ],
    });
  });

  it("服务端 422 字段错误：显示在对应表单项上，停留在新建页", async () => {
    const { router } = renderAdminApp("/events/new", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "POST /api/admin/events": () =>
        jsonResponse(422, {
          error: {
            code: "VALIDATION_FAILED",
            message: "Validation failed",
            fields: { slug: "Slug already taken", "categories[0].code": "Category code is invalid" },
          },
        }),
    });

    await screen.findByTestId("event-form-submit");
    await fillMinimalEventForm();
    await userEvent.click(screen.getByTestId("event-form-submit"));

    expect(await screen.findByText("Slug already taken")).toBeInTheDocument();
    expect(screen.getByText("Category code is invalid")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events/new");
  });
});
