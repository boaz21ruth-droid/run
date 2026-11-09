import { screen, waitFor, within } from "@testing-library/react";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse, opsMe } from "../test/fixtures";
import { setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

const staffMe: Schemas["Me"] = {
  staff: { id: 5, username: "staff.sokha", fullName: "Sokha Ly", role: "RACE_STAFF" },
  permissions: { racepack_issue: "write" },
};
const supervisorMe: Schemas["Me"] = {
  staff: { id: 6, username: "sup.vann", fullName: "Vann Chea", role: "RACE_SUPERVISOR" },
  permissions: { racepack_issue: "write", racepack_undo: "write" },
};

const event: Schemas["RacepackEvent"] = {
  id: 7,
  name: { en: "Phnom Penh Half Marathon 2026" },
  city: "Phnom Penh",
  raceDate: "2026-11-15",
  timezone: "Asia/Phnom_Penh",
};

const entry = (over: Partial<Schemas["RacepackEntry"]> = {}): Schemas["RacepackEntry"] => ({
  registrationId: 31,
  regNo: "RG7K3M9Q2A",
  orderNo: "WR7K3M9",
  status: "CONFIRMED",
  orderStatus: "PAID",
  fullName: "SOK DARA",
  tshirtSize: "M",
  phoneLast4: "5678",
  audience: "ALL",
  categoryCode: "21K",
  categoryName: { en: "Half marathon" },
  bib: "1024",
  picked: false,
  pickedAt: null,
  pickedByName: null,
  proxyName: null,
  idVerified: false,
  blockReason: null,
  ...over,
});

const station = (results: Schemas["RacepackEntry"][], picked = 128): Schemas["RacepackStation"] => ({
  event,
  confirmed: 296,
  picked,
  recent: [],
  results,
});

function stationRoute(byQuery: Record<string, Schemas["RacepackEntry"][]>, picked?: number) {
  return (request: Request) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return jsonResponse(200, station(byQuery[q] ?? [], picked));
  };
}

function issueRequest(requests: Request[]) {
  return requests.find((r) => r.method === "POST" && new URL(r.url).pathname === "/api/admin/racepack/registrations/31/issue");
}

describe("领物核销站", () => {
  it("现场人员登录后落在核销站；只有一场赛事时直接打开，显示进度", async () => {
    const { router } = renderAdminApp("/", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({}),
    });

    expect(await screen.findByTestId("racepack-progress")).toHaveTextContent("128 / 296 issued");
    expect(router.state.location.pathname).toBe("/racepack");
    expect(screen.queryByTestId("racepack-event")).not.toBeInTheDocument();
  });

  it("没被指派任何赛事时提示联系管理员", async () => {
    renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [] }),
    });
    expect(await screen.findByTestId("racepack-no-events")).toHaveTextContent("not assigned");
  });

  it("搜到人后本人领取：带设备 ID 与 clientEventId，成功后清空搜索", async () => {
    const { requests } = renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({ "1024": [entry()] }),
      "POST /api/admin/racepack/registrations/31/issue": () =>
        jsonResponse(200, { outcome: "APPLIED", entry: entry({ picked: true, pickedAt: "2026-11-13T10:42:00Z", pickedByName: "Sokha Ly" }) }),
    });
    const user = setupFormUser();

    await user.type(await screen.findByTestId("racepack-search"), "1024{Enter}");
    const card = await screen.findByTestId("racepack-entry-31");
    expect(card).toHaveTextContent("SOK DARA");
    expect(card).toHaveTextContent("Ref WR7K3M9");
    expect(card).toHaveTextContent("phone …5678");

    await user.click(within(card).getByTestId("racepack-entry-31-self"));

    await waitFor(() => expect(issueRequest(requests)).toBeDefined());
    const body = (await issueRequest(requests)!.clone().json()) as Record<string, unknown>;
    expect(body.deviceId).toMatch(/^web-/);
    expect(body.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.proxyName).toBeUndefined();
    expect(issueRequest(requests)!.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await screen.findByText("Issued to SOK DARA")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("racepack-search")).toHaveValue(""));
  });

  it("代领要填姓名并勾选核对后才能发放", async () => {
    const { requests } = renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({ dara: [entry()] }),
      "POST /api/admin/racepack/registrations/31/issue": () =>
        jsonResponse(200, { outcome: "APPLIED", entry: entry({ picked: true, proxyName: "CHAN SOPHEA" }) }),
    });
    const user = setupFormUser();

    await user.type(await screen.findByTestId("racepack-search"), "dara{Enter}");
    await user.click(await screen.findByTestId("racepack-entry-31-proxy"));
    const confirm = screen.getByTestId("racepack-entry-31-proxy-confirm");
    expect(confirm).toBeDisabled();
    await user.type(screen.getByTestId("racepack-entry-31-proxy-name"), "CHAN SOPHEA");
    expect(confirm).toBeDisabled();
    await user.click(screen.getByTestId("racepack-entry-31-proxy-check"));
    await user.click(confirm);

    await waitFor(() => expect(issueRequest(requests)).toBeDefined());
    expect(await issueRequest(requests)!.clone().json()).toMatchObject({ proxyName: "CHAN SOPHEA" });
  });

  it("本地价参赛人先勾选证件核验才能本人领取", async () => {
    const { requests } = renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({ dara: [entry({ audience: "LOCAL" })] }),
      "POST /api/admin/racepack/registrations/31/issue": () =>
        jsonResponse(200, { outcome: "APPLIED", entry: entry({ audience: "LOCAL", picked: true, idVerified: true }) }),
    });
    const user = setupFormUser();

    await user.type(await screen.findByTestId("racepack-search"), "dara{Enter}");
    const self = await screen.findByTestId("racepack-entry-31-self");
    expect(screen.getByTestId("racepack-entry-31")).toHaveTextContent("Cambodian rate · ID required");
    expect(self).toBeDisabled();
    await user.click(screen.getByTestId("racepack-entry-31-id-check"));
    await user.click(self);

    await waitFor(() => expect(issueRequest(requests)).toBeDefined());
    expect(await issueRequest(requests)!.clone().json()).toMatchObject({ idVerified: true });
  });

  it("付款未核验的人显示为拦下，没有发放按钮", async () => {
    renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({
        lim: [entry({ fullName: "LIM VUTHY", bib: "1031", status: "PENDING", blockReason: "NOT_PAID" })],
      }),
    });
    const user = setupFormUser();

    await user.type(await screen.findByTestId("racepack-search"), "lim{Enter}");
    const card = await screen.findByTestId("racepack-entry-31");
    expect(card).toHaveAttribute("data-state", "blocked");
    expect(card).toHaveTextContent("1031 · LIM VUTHY · Payment not verified");
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
  });

  it("已领取的人：现场工作人员不能撤销，现场主管写原因后撤销", async () => {
    const picked = entry({ picked: true, pickedAt: "2026-11-13T10:42:00Z", pickedByName: "Pisey", proxyName: null });
    const staffView = renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, staffMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({ dara: [picked] }),
    });
    const user = setupFormUser();
    await user.type(await screen.findByTestId("racepack-search"), "dara{Enter}");
    const card = await screen.findByTestId("racepack-entry-31");
    expect(card).toHaveTextContent("Collected");
    expect(card).toHaveTextContent("2026-11-13 17:42 · Pisey · in person");
    expect(screen.queryByTestId("racepack-entry-31-undo")).not.toBeInTheDocument();
    staffView.unmount();

    const { requests } = renderAdminApp("/racepack", {
      "GET /api/admin/me": () => jsonResponse(200, supervisorMe),
      "GET /api/admin/racepack/events": () => jsonResponse(200, { items: [event] }),
      "GET /api/admin/racepack/events/7": stationRoute({ dara: [picked] }),
      "POST /api/admin/racepack/registrations/31/undo": () => jsonResponse(200, { outcome: "APPLIED", entry: entry() }),
    });
    await user.type(await screen.findByTestId("racepack-search"), "dara{Enter}");
    await user.click(await screen.findByTestId("racepack-entry-31-undo"));
    const dialog = await screen.findByRole("dialog");
    const ok = within(dialog).getByRole("button", { name: "Undo pickup" });
    expect(ok).toBeDisabled();
    await user.type(within(dialog).getByTestId("racepack-entry-31-undo-reason"), "Wrong person");
    await user.click(ok);

    await waitFor(() =>
      expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/registrations/31/undo"))).toBe(true),
    );
    const undo = requests.find((r) => r.url.endsWith("/registrations/31/undo"))!;
    expect(await undo.clone().json()).toMatchObject({ reason: "Wrong person" });
  });

  it("运营可以看核销站，但菜单项在订单之后，落地页仍是赛事", async () => {
    const { router } = renderAdminApp("/", {
      "GET /api/admin/me": () => jsonResponse(200, { ...opsMe, permissions: { ...opsMe.permissions, racepack_issue: "read" } }),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/events"));
  });
});
