import { screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import dayjs from "dayjs";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, draftEvent, jsonResponse, opsMe, photographerMe, unauthenticated } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

type FormUser = ReturnType<typeof userEvent.setup>;

/**
 * 表单测试专用的 user-event 实例：关闭 pointer-events 检查。
 * 默认每次点击都会沿祖先链调用 getComputedStyle，而 antd 的 CSS-in-JS 往 jsdom 注入约 540KB 样式，
 * 单次调用约 0.5 秒，填一张表就超过 15 秒超时。表单输入框不存在 pointer-events: none 的情况，关掉不丢覆盖。
 */
function setupFormUser(): FormUser {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

/** 按 antd 生成的 id 聚焦后一次性粘贴字段值 */
async function fillField(user: FormUser, id: string, value: string): Promise<void> {
  await user.click(document.querySelector<HTMLElement>(`#${id}`)!);
  await user.paste(value);
}

/** 日期框粘贴后用 tab 失焦确认，避免在表单内按 Enter 触发原生隐式提交 */
async function fillDateField(user: FormUser, id: string, value: string): Promise<void> {
  await fillField(user, id, value);
  await user.tab();
}

/** 填写除时间外的必填字段；startAt/cutoffAt 由各测试按需单独填写 */
async function fillMinimalEventForm(user: FormUser): Promise<void> {
  await fillField(user, "event_slug", "phnom-penh-half-2026");
  await fillField(user, "event_name_zh", "金边半程马拉松 2026");
  await fillField(user, "event_name_en", "Phnom Penh Half Marathon 2026");
  await fillField(user, "event_name_km", "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ");
  await fillField(user, "event_city", "Phnom Penh");
  await fillDateField(user, "event_raceDate", "2026-11-15");
  await fillField(user, "event_categories_0_code", "21K");
  await fillField(user, "event_categories_0_name_zh", "半程");
  await fillField(user, "event_categories_0_name_en", "Half marathon");
  await fillField(user, "event_categories_0_name_km", "ពាក់កណ្ដាល");
  await fillField(user, "event_categories_0_distanceM", "21097");
  await fillField(user, "event_categories_0_capacity", "800");
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

    const user = setupFormUser();
    await screen.findByTestId("event-form-submit");
    await fillMinimalEventForm(user);
    await fillDateField(user, "event_categories_0_startAt", "2026-11-15 06:00");
    await fillDateField(user, "event_categories_0_cutoffAt", "2026-11-15 09:00");

    await user.click(screen.getByTestId("event-form-submit"));

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

    const user = setupFormUser();
    await screen.findByTestId("event-form-submit");
    await fillMinimalEventForm(user);
    await user.click(screen.getByTestId("event-form-submit"));

    expect(await screen.findByText("Slug already taken")).toBeInTheDocument();
    expect(screen.getByText("Category code is invalid")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events/new");
  });
});
