import { screen, waitFor, within } from "@testing-library/react";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { financeMe, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";
import { volunteerDateOptions } from "./VolunteersTab";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

const name = (s: string) => ({ zh: s, en: s, km: s });
const role = (id: number, label: string, assigned: number, capacity: number): Schemas["AdminVolunteerRole"] => ({
  id,
  name: name(label),
  schedule: null,
  capacity,
  assignedCount: assigned,
  sortOrder: id,
  active: true,
  candidates: 1,
});
const app = (patch: Partial<Schemas["AdminVolunteerApplication"]> = {}): Schemas["AdminVolunteerApplication"] => ({
  id: 21,
  status: "PENDING",
  fullName: "Sok Dara",
  phone: "+85512345678",
  telegramUsername: "sokdara",
  fullAvailability: false,
  dates: ["2026-11-15"],
  roleIds: [2, 1],
  tshirtSize: "M",
  note: null,
  mediaConsent: true,
  assignedRoleId: null,
  reviewNote: null,
  createdAt: "2026-11-01T03:00:00Z",
  ...patch,
});
const board: Schemas["VolunteerBoard"] = {
  settings: { open: true, dates: ["2026-11-13", "2026-11-15"], note: null },
  roles: [role(1, "Check-in", 1, 8), role(2, "Bib pickup", 2, 2)],
  applications: [app(), app({ id: 22, fullName: "Lim Sophea", status: "ASSIGNED", assignedRoleId: 1, roleIds: [1] })],
};

function routes(extra: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  return {
    "GET /api/admin/me": () => jsonResponse(200, opsMe),
    "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
    "GET /api/admin/events/7/volunteers": () => jsonResponse(200, board),
    ...extra,
  };
}

describe("志愿者页", () => {
  it("可选日期是比赛日与赛前 13 天", () => {
    const options = volunteerDateOptions("2026-11-15");
    expect(options).toHaveLength(14);
    expect(options[0]).toBe("2026-11-02");
    expect(options.at(-1)).toBe("2026-11-15");
  });

  it("岗位显示席位与满员；申请按选的第一个有空位的岗位分配", async () => {
    const posted: { path: string; body: unknown }[] = [];
    renderAdminApp(
      "/events/7",
      routes({
        "POST /api/admin/volunteer-applications/21/assign": async (request) => {
          posted.push({ path: new URL(request.url).pathname, body: await request.json() });
          return jsonResponse(200, board);
        },
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-volunteers"));
    expect(await screen.findByTestId("volunteer-role-seats-2")).toHaveTextContent("2 / 2Full");
    expect(screen.getByTestId("volunteer-summary")).toHaveTextContent("1 waiting · 1 assigned · 0 waitlisted");
    const row = screen.getByText("Sok Dara").closest("tr")!;
    expect(row).toHaveTextContent("11/15");
    expect(row).toHaveTextContent("T-shirt M · Photos OK");

    // 选的第一个岗位 Bib pickup 已满，默认落到 Check-in
    await user.click(screen.getByTestId("volunteer-assign-21"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ path: "/api/admin/volunteer-applications/21/assign", body: { roleId: 1 } });
  });

  it("新建岗位、保存招募设置、不安排带备注", async () => {
    const bodies: Record<string, unknown> = {};
    const record = (key: string) => async (request: Request) => {
      const text = await request.text();
      bodies[key] = text ? JSON.parse(text) : null;
      return jsonResponse(key === "role" ? 201 : 200, board);
    };
    renderAdminApp(
      "/events/7",
      routes({
        "POST /api/admin/events/7/volunteer-roles": record("role"),
        "PUT /api/admin/events/7/volunteer-settings": record("settings"),
        "POST /api/admin/volunteer-applications/21/reject": record("reject"),
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-volunteers"));
    await user.click(await screen.findByTestId("volunteer-role-create"));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name (Chinese)"), "补给站");
    await user.type(within(dialog).getByLabelText("Name (English)"), "Water station");
    await user.type(within(dialog).getByLabelText("Name (Khmer)"), "ស្ថានីយទឹក");
    await user.click(within(dialog).getByTestId("volunteer-role-submit"));
    await waitFor(() => expect(bodies.role).toBeDefined());
    expect(bodies.role).toEqual({
      name: { zh: "补给站", en: "Water station", km: "ស្ថានីយទឹក" },
      schedule: { zh: "", en: "", km: "" },
      capacity: 5,
      sortOrder: 0,
    });

    await user.type(screen.getByLabelText("Note (English)"), "T-shirt and meals");
    await user.click(screen.getByTestId("volunteer-settings-save"));
    await waitFor(() => expect(bodies.settings).toBeDefined());
    expect(bodies.settings).toEqual({ open: true, dates: ["2026-11-13", "2026-11-15"], note: { zh: "", en: "T-shirt and meals", km: "" } });

    await user.click(screen.getByTestId("volunteer-reject-21"));
    await user.type(await screen.findByTestId("volunteer-reject-note"), "Enough people this time");
    await user.click(screen.getByTestId("volunteer-reject-confirm"));
    await waitFor(() => expect(bodies.reject).toEqual({ note: "Enough people this time" }));
  });

  it("只读角色看得到，但不能改", async () => {
    renderAdminApp("/events/7", routes({ "GET /api/admin/me": () => jsonResponse(200, financeMe) }));
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-volunteers"));
    expect(await screen.findByText("Sok Dara")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-role-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-assign-21")).not.toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-settings-save")).not.toBeInTheDocument();
  });
});
