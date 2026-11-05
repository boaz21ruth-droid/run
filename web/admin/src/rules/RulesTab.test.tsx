import { screen, waitFor, within } from "@testing-library/react";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { financeMe, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";
import { formatDuration, parseDuration } from "./duration";
import { toRefundPolicy } from "./RulesTab";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

const name = (s: string) => ({ zh: s, en: s, km: s });
const event: Schemas["AdminEvent"] = {
  ...publishedEvent,
  refundPolicy: { tiers: [{ days: 14, percent: 80 }], transferDays: null },
  categories: [
    {
      ...publishedEvent.categories[0]!,
      id: 11,
      code: "21KE",
      name: name("21K elite"),
      qualification: { rule: name("21K under 1:45"), maxTimeMs: 6300000, fallbackCategoryId: 12 },
    },
    { ...publishedEvent.categories[0]!, id: 12, code: "21K", name: name("21K open"), qualification: null },
    { ...publishedEvent.categories[0]!, id: 13, code: "10K", name: name("10K"), qualification: null },
  ],
};

function proof(patch: Partial<Schemas["AdminQualificationProof"]> = {}): Schemas["AdminQualificationProof"] {
  return {
    id: 5,
    status: "PENDING",
    registrationId: 50,
    regNo: "RG4N8P2QTZ",
    fullName: "Sok Dara",
    registrationStatus: "CONFIRMED",
    categoryId: 11,
    categoryCode: "21KE",
    fallbackCategoryCode: "21K",
    bestTimeMs: 6080000,
    maxTimeMs: 6300000,
    source: "Mekong Night Run 2025",
    proofUrl: "https://results.mekong.kh/123",
    reviewNote: null,
    movedToCategoryCode: null,
    reviewedAt: null,
    createdAt: "2026-11-01T03:00:00Z",
    ...patch,
  };
}

function routes(extra: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  return {
    "GET /api/admin/me": () => jsonResponse(200, opsMe),
    "GET /api/admin/events/7": () => jsonResponse(200, event),
    "GET /api/admin/events/7/qualification-proofs": () =>
      jsonResponse(200, { items: [proof(), proof({ id: 6, fullName: "Lim Sophea", registrationStatus: "PENDING" })] }),
    ...extra,
  };
}

describe("报名规则页", () => {
  it("成绩格式与退改政策表单转换", () => {
    expect(parseDuration("1:45:00")).toBe(6300000);
    expect(formatDuration(6080000)).toBe("1:41:20");
    expect(
      toRefundPolicy({ enabled: true, tiers: [{ days: 7, percent: 50 }, { days: 14, percent: 80 }, { days: null, percent: 10 }], transfer: true, transferDays: 3 }),
    ).toEqual({ tiers: [{ days: 14, percent: 80 }, { days: 7, percent: 50 }], transferDays: 3 });
    expect(toRefundPolicy({ enabled: true, tiers: [], transfer: false, transferDays: 3 })).toEqual({ tiers: [], transferDays: null });
    expect(toRefundPolicy({ enabled: false, tiers: [], transfer: true, transferDays: 3 })).toBeNull();
  });

  it("保存退改政策：加一档、开启转让", async () => {
    let sent: unknown = null;
    renderAdminApp(
      "/events/7",
      routes({
        "PUT /api/admin/events/7/refund-policy": async (request) => {
          sent = await request.json();
          return jsonResponse(200, event);
        },
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-rules"));
    await user.click(await screen.findByTestId("refund-add-tier"));
    await user.type(screen.getByTestId("refund-days-1"), "7");
    await user.type(screen.getByTestId("refund-percent-1"), "50");
    await user.click(screen.getByTestId("refund-transfer"));
    await user.click(screen.getByTestId("refund-save"));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({ policy: { tiers: [{ days: 14, percent: 80 }, { days: 7, percent: 50 }], transferDays: 3 } });
  });

  it("精英组设置：显示要求与去处，可以取消资格要求", async () => {
    const bodies: unknown[] = [];
    renderAdminApp(
      "/events/7",
      routes({
        "PUT /api/admin/categories/11/qualification": async (request) => {
          bodies.push(await request.json());
          return jsonResponse(200, event);
        },
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-rules"));
    const row = (await screen.findByText("21K under 1:45")).closest("tr")!;
    expect(row).toHaveTextContent("≤ 1:45:00");
    expect(row).toHaveTextContent("If not verified → 21K");

    await user.click(screen.getByTestId("qualify-edit-21KE"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Time limit")).toHaveValue("1:45:00");
    await user.click(within(dialog).getByTestId("qualify-save"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ qualification: { rule: name("21K under 1:45"), maxTimeMs: 6300000, fallbackCategoryId: 12 } });
  });

  it("核验：通过、不通过带备注；未付款的不能核验", async () => {
    const posted: { path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      const text = await request.text();
      posted.push({ path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
      return jsonResponse(200, proof({ status: "APPROVED" }));
    };
    renderAdminApp(
      "/events/7",
      routes({
        "POST /api/admin/qualification-proofs/5/approve": record,
        "POST /api/admin/qualification-proofs/5/reject": record,
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-rules"));
    expect(await screen.findByText("Sok Dara")).toBeInTheDocument();
    expect(screen.getByTestId("proofs-summary")).toHaveTextContent("2 to check / 2 total");
    const dara = screen.getByText("Sok Dara").closest("tr")!;
    expect(dara).toHaveTextContent("1:41:20");
    expect(within(dara).getByRole("link")).toHaveAttribute("href", "https://results.mekong.kh/123");
    expect(screen.getByTestId("proof-approve-6")).toBeDisabled();

    await user.click(screen.getByTestId("proof-approve-5"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe("/api/admin/qualification-proofs/5/approve");

    await user.click(screen.getByTestId("proof-reject-5"));
    expect(await screen.findByText(/The entry moves to 21K/)).toBeInTheDocument();
    await user.type(screen.getByTestId("proof-reject-note"), "Name not on the results page");
    await user.click(screen.getByTestId("proof-reject-confirm"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ path: "/api/admin/qualification-proofs/5/reject", body: { note: "Name not on the results page" } });
  });

  it("只读角色看得到，但没有保存与核验按钮", async () => {
    renderAdminApp("/events/7", routes({ "GET /api/admin/me": () => jsonResponse(200, financeMe) }));
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-rules"));
    expect(await screen.findByText("Sok Dara")).toBeInTheDocument();
    expect(screen.queryByTestId("refund-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("qualify-edit-21KE")).not.toBeInTheDocument();
    expect(screen.queryByTestId("proof-approve-5")).not.toBeInTheDocument();
  });
});
