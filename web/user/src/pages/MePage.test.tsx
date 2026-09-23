import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { saveToken } from "../auth/session";
import { apiRoutes, jsonResponse, runnerSession } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

describe("MePage", () => {
  it("同时改显示名与语言时两个字段一起提交", async () => {
    const user = userEvent.setup();
    let patched: unknown;
    renderApp(
      "/me",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
        "PATCH /api/app/me": async (request) => {
          patched = await request.clone().json();
          return jsonResponse(200, { ...runnerSession("tok-1").user, displayName: "Dara", locale: "km" });
        },
      }),
      { initData: "signed-init-data" },
    );

    const nameInput = await screen.findByTestId("me-display-name");
    await user.clear(nameInput);
    await user.type(nameInput, "Dara");
    await user.selectOptions(screen.getByTestId("me-locale"), "km");
    await user.click(screen.getByTestId("me-save"));

    await waitFor(() => expect(patched).toEqual({ displayName: "Dara", locale: "km" }));
  });

  it("手机号跑者没有显示名时只改语言，请求里不带 displayName", async () => {
    const user = userEvent.setup();
    let patched: unknown;
    let patchCount = 0;
    const phoneUser = {
      id: 2,
      telegramUserId: null,
      telegramUsername: null,
      phoneMasked: "+855***678",
      displayName: "",
      locale: "en" as const,
    };
    saveToken("tok-phone", "2099-01-01T00:00:00Z");
    renderApp(
      "/me",
      apiRoutes({
        "GET /api/app/me": () => jsonResponse(200, phoneUser),
        "PATCH /api/app/me": async (request) => {
          patchCount += 1;
          patched = await request.clone().json();
          return jsonResponse(200, { ...phoneUser, locale: "km" });
        },
      }),
      { initData: null },
    );

    expect(await screen.findByTestId("me-display-name")).toHaveValue("");
    expect(await screen.findByTestId("nav-me")).toHaveTextContent("+855***678");

    await user.selectOptions(screen.getByTestId("me-locale"), "km");
    await user.click(screen.getByTestId("me-save"));

    await waitFor(() => expect(patched).toEqual({ locale: "km" }));
    expect(patchCount).toBe(1);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByTestId("nav-me")).toHaveTextContent("+855***678");
  });

  it("两个字段都没改时不发请求，直接提示已保存", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(
      "/me",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
      }),
      { initData: "signed-init-data" },
    );

    await screen.findByTestId("me-display-name");
    await user.click(screen.getByTestId("me-save"));

    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("保存显示名并调用 PATCH /app/me，成功后提示已保存并更新顶栏", async () => {
    const user = userEvent.setup();
    let patched: unknown;
    const { requests } = renderApp(
      "/me",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
        "PATCH /api/app/me": async (request) => {
          patched = await request.clone().json();
          return jsonResponse(200, { ...runnerSession("tok-1").user, displayName: "Dara" });
        },
      }),
      { initData: "signed-init-data" },
    );

    const nameInput = await screen.findByTestId("me-display-name");
    expect(nameInput).toHaveValue("Sok Dara");
    await user.clear(nameInput);
    await user.type(nameInput, "Dara");
    await user.click(screen.getByTestId("me-save"));

    await waitFor(() => expect(patched).toEqual({ displayName: "Dara" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(await screen.findByTestId("nav-me")).toHaveTextContent("Dara");
    const patchRequest = requests.find((r) => r.method === "PATCH")!;
    expect(patchRequest.headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("切换语言下拉框会立即切换界面语言", async () => {
    const user = userEvent.setup();
    renderApp(
      "/me",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
      }),
      { initData: "signed-init-data" },
    );

    await screen.findByTestId("me-display-name");
    expect(document.documentElement.lang).toBe("en");

    await user.selectOptions(screen.getByTestId("me-locale"), "km");

    await waitFor(() => expect(document.documentElement.lang).toBe("km"));
    expect(screen.getByTestId("me-save")).toHaveTextContent("រក្សាទុក");
  });

  it("点击退出登录后清空登录态并跳转首页", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(
      "/me",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
        "POST /api/app/auth/logout": () => new Response(null, { status: 204 }),
        "GET /api/events": () => jsonResponse(200, { items: [] }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("me-logout"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByTestId("nav-me")).not.toBeInTheDocument();
  });
});
