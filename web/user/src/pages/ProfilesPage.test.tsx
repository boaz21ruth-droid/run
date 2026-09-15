import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { apiRoutes, daraProfile, jsonResponse, runnerSession } from "../test/fixtures";
import { renderApp } from "../test/renderApp";
import { pasteInto } from "../test/userInput";

type User = ReturnType<typeof userEvent.setup>;

const pathOf = (request: Request) => new URL(request.url).pathname;
const unauthorized = () => jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Please sign in." } });

async function fillValidProfile(user: User) {
  await pasteInto(user, screen.getByTestId("profile-fullName"), "Chan Sreymom");
  await user.selectOptions(screen.getByTestId("profile-gender"), "F");
  fireEvent.change(screen.getByTestId("profile-birthDate"), { target: { value: "1995-02-28" } });
  await pasteInto(user, screen.getByTestId("profile-nationality"), "kh");
  await user.selectOptions(screen.getByTestId("profile-idType"), "PASSPORT");
  await pasteInto(user, screen.getByTestId("profile-idNo"), "n0 1234-9999");
  await pasteInto(user, screen.getByTestId("profile-phone"), "+855 11 222 333");
  await pasteInto(user, screen.getByTestId("profile-emergencyName"), "Chan Dara");
  await pasteInto(user, screen.getByTestId("profile-emergencyPhone"), "+85599888777");
  await user.selectOptions(screen.getByTestId("profile-tshirtSize"), "S");
}

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

describe("ProfilesPage", () => {
  it("登录后列出常用参赛人，证件号只显示后 4 位，请求带跑者令牌", async () => {
    const { requests } = renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession("tok-1")),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
      }),
      { initData: "signed-init-data" },
    );

    const item = await screen.findByTestId("profile-item-7");
    expect(item).toHaveTextContent("Sok Dara");
    expect(item).toHaveTextContent("******5678");
    expect(item).toHaveTextContent("+85512345678");
    expect(item).toHaveTextContent("Myself");
    expect(screen.getByRole("heading", { name: "Saved runners" })).toBeInTheDocument();
    const list = requests.find((r) => pathOf(r) === "/api/app/profiles")!;
    expect(list.headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("没有资料时显示空状态", async () => {
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [] }),
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByText(/No saved runners yet/)).toBeInTheDocument();
  });

  it("不在 Telegram 中时显示 open-in-telegram，不请求参赛人", async () => {
    const { requests } = renderApp("/profiles", apiRoutes({}), { initData: null });

    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("提交空表单时逐项提示必填，不发请求", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [] }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-create"));
    await user.click(screen.getByTestId("profile-submit"));

    expect(screen.getByTestId("form-error")).toHaveTextContent("Please check the highlighted fields.");
    expect(screen.getByTestId("profile-fullName-error")).toHaveTextContent("Required.");
    expect(screen.getByTestId("profile-idNo-error")).toHaveTextContent("Required.");
    expect(screen.getByTestId("profile-tshirtSize-error")).toHaveTextContent("Required.");
    expect(screen.queryByTestId("profile-email-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("profile-fullName")).toHaveAttribute("aria-invalid", "true");
    expect(requests.some((r) => r.method === "POST" && pathOf(r) === "/api/app/profiles")).toBe(false);
  });

  it("新建成功后回到列表并显示新资料", async () => {
    const user = userEvent.setup();
    let items: Schemas["RunnerProfile"][] = [];
    let posted: unknown;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items }),
        "POST /api/app/profiles": async (request) => {
          posted = await request.clone().json();
          const created: Schemas["RunnerProfile"] = {
            ...daraProfile,
            id: 8,
            fullName: "Chan Sreymom",
            gender: "F",
            idType: "PASSPORT",
            idNoMasked: "******9999",
            isSelf: false,
          };
          items = [created];
          return jsonResponse(201, created);
        },
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-create"));
    await fillValidProfile(user);
    await user.click(screen.getByTestId("profile-submit"));

    expect(await screen.findByTestId("profile-item-8")).toHaveTextContent("******9999");
    expect(screen.queryByTestId("profile-submit")).not.toBeInTheDocument();
    expect(posted).toEqual({
      fullName: "Chan Sreymom",
      gender: "F",
      birthDate: "1995-02-28",
      nationality: "KH",
      idType: "PASSPORT",
      idNo: "N012349999",
      phone: "+85511222333",
      emergencyName: "Chan Dara",
      emergencyPhone: "+85599888777",
      tshirtSize: "S",
      isSelf: false,
    });
  });

  it("编辑时证件号留空，请求体不带 idNo", async () => {
    const user = userEvent.setup();
    let put: { path: string; body: Record<string, unknown> } | undefined;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
        "PUT /api/app/profiles/7": async (request) => {
          put = { path: pathOf(request), body: (await request.clone().json()) as Record<string, unknown> };
          return jsonResponse(200, { ...daraProfile, fullName: "Sok Dara Jr" });
        },
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-edit-7"));
    const fullName = screen.getByTestId("profile-fullName");
    expect(fullName).toHaveValue("Sok Dara");
    expect(screen.getByTestId("profile-idNo")).toHaveValue("");
    expect(screen.getByText("Current ID number ******5678. Leave blank to keep it.")).toBeInTheDocument();
    expect(screen.getByTestId("profile-isSelf")).toBeChecked();
    await user.clear(fullName);
    await user.type(fullName, "Sok Dara Jr");
    await user.click(screen.getByTestId("profile-submit"));

    await waitFor(() => expect(put).toBeDefined());
    expect(put!.path).toBe("/api/app/profiles/7");
    expect(put!.body.fullName).toBe("Sok Dara Jr");
    expect("idNo" in put!.body).toBe(false);
    expect(put!.body.isSelf).toBe(true);
    expect(await screen.findByTestId("profile-item-7")).toBeInTheDocument();
  });

  it("服务端字段错误显示在对应字段下", async () => {
    const user = userEvent.setup();
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [] }),
        "POST /api/app/profiles": () =>
          jsonResponse(422, {
            error: {
              code: "VALIDATION_FAILED",
              message: "Please check the highlighted fields.",
              fields: { phone: "Invalid format." },
            },
          }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-create"));
    await fillValidProfile(user);
    await user.click(screen.getByTestId("profile-submit"));

    expect(await screen.findByTestId("profile-phone-error")).toHaveTextContent("Invalid format.");
    expect(screen.getByTestId("form-error")).toHaveTextContent("Please check the highlighted fields.");
    expect(screen.getByTestId("profile-submit")).toBeEnabled();
  });

  it("取消编辑回到列表，不发请求", async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-edit-7"));
    await user.click(screen.getByTestId("profile-cancel"));

    expect(await screen.findByTestId("profile-item-7")).toBeInTheDocument();
    expect(requests.filter((r) => r.method !== "GET" && pathOf(r) !== "/api/app/auth/telegram")).toHaveLength(0);
  });

  it("删除需要二次确认", async () => {
    const user = userEvent.setup();
    let items: Schemas["RunnerProfile"][] = [daraProfile];
    const deleted: string[] = [];
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => jsonResponse(200, runnerSession()),
        "GET /api/app/profiles": () => jsonResponse(200, { items }),
        "DELETE /api/app/profiles/7": (request) => {
          deleted.push(pathOf(request));
          items = [];
          return new Response(null, { status: 204 });
        },
      }),
      { initData: "signed-init-data" },
    );

    await user.click(await screen.findByTestId("profile-delete-7"));
    expect(screen.getByText("Delete Sok Dara?")).toBeInTheDocument();
    expect(deleted).toHaveLength(0);

    await user.click(screen.getByTestId("profile-delete-cancel-7"));
    expect(screen.queryByTestId("profile-delete-confirm-7")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("profile-delete-7"));
    await user.click(screen.getByTestId("profile-delete-confirm-7"));

    expect(await screen.findByText(/No saved runners yet/)).toBeInTheDocument();
    expect(deleted).toEqual(["/api/app/profiles/7"]);
  });

  it("令牌失效时用 initData 重新登录一次并重试查询", async () => {
    let logins = 0;
    const listAuth: (string | null)[] = [];
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => {
          logins += 1;
          return jsonResponse(200, runnerSession(`tok-${logins}`));
        },
        "GET /api/app/profiles": (request) => {
          const authorization = request.headers.get("Authorization");
          listAuth.push(authorization);
          return authorization === "Bearer tok-1" ? unauthorized() : jsonResponse(200, { items: [daraProfile] });
        },
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByTestId("profile-item-7")).toBeInTheDocument();
    expect(logins).toBe(2);
    expect(listAuth).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(window.sessionStorage.getItem("werun.appToken")).toBe("tok-2");
  });

  it("重新登录后仍然 401 时只重试一次", async () => {
    let logins = 0;
    let listCalls = 0;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => {
          logins += 1;
          return jsonResponse(200, runnerSession(`tok-${logins}`));
        },
        "GET /api/app/profiles": () => {
          listCalls += 1;
          return unauthorized();
        },
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    await waitFor(() => expect(logins).toBe(3));
    expect(listCalls).toBe(2);
  });

  it("重新登录失败时显示 open-in-telegram", async () => {
    let logins = 0;
    renderApp(
      "/profiles",
      apiRoutes({
        "POST /api/app/auth/telegram": () => {
          logins += 1;
          return logins === 1
            ? jsonResponse(200, runnerSession("tok-1"))
            : jsonResponse(401, { error: { code: "TELEGRAM_AUTH_INVALID", message: "Open the mini app again." } });
        },
        "GET /api/app/profiles": unauthorized,
      }),
      { initData: "signed-init-data" },
    );

    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
    expect(logins).toBe(2);
    expect(window.sessionStorage.getItem("werun.appToken")).toBeNull();
  });
});
