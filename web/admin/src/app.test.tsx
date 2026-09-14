import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, draftEvent, jsonResponse, opsMe, photographerMe, unauthenticated } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

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
