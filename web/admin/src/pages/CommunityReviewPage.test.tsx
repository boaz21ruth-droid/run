import { screen, waitFor } from "@testing-library/react";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, jsonResponse, opsMe } from "../test/fixtures";
import { setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

const ops: Schemas["Me"] = { ...opsMe, permissions: { ...opsMe.permissions, content_manage: "write" } };
const admin: Schemas["Me"] = { ...adminMe, permissions: { ...adminMe.permissions, content_manage: "read" } };

const row = (patch: Partial<Schemas["CommunityActivity"]> = {}, extra: Partial<Schemas["AdminCommunityActivity"]> = {}): Schemas["AdminCommunityActivity"] => ({
  activity: {
    id: 5,
    title: "Night run · Riverside 8K",
    tag: "NIGHT",
    startsAt: "2026-11-11T12:00:00Z",
    city: "Phnom Penh",
    location: "Riverside",
    meetPoint: "Monument",
    distanceText: "8K",
    capacity: 10,
    joinedCount: 0,
    waitlistCount: 0,
    feeNote: "Free",
    hostName: "BKK Runners",
    authorName: "Rithy",
    body: "Easy pace.",
    contactVisibility: "JOINED",
    status: "REVIEWING",
    rejectCode: null,
    frozen: false,
    joinerInitials: [],
    ...patch,
  },
  authorTelegram: "rithy",
  contactTelegram: "bkk_runners",
  contactPhone: null,
  reviewRequired: true,
  freezeReason: null,
  createdAt: "2026-11-05T03:00:00Z",
  ...extra,
});

describe("跑团活动审核", () => {
  it("待审核列表：通过、不通过选原因", async () => {
    const posted: { path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      const text = await request.text();
      posted.push({ path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
      return jsonResponse(200, row({ status: "PUBLISHED" }));
    };
    renderAdminApp("/community", {
      "GET /api/admin/me": () => jsonResponse(200, ops),
      "GET /api/admin/community/activities": (request) =>
        jsonResponse(200, { items: new URL(request.url).searchParams.get("status") === "REVIEWING" ? [row()] : [] }),
      "POST /api/admin/community/activities/5/approve": record,
      "POST /api/admin/community/activities/5/reject": record,
    });
    const user = setupFormUser();
    expect(await screen.findByText("Night run · Riverside 8K")).toBeInTheDocument();
    expect(screen.getByText("@rithy")).toHaveAttribute("href", "https://t.me/rithy");
    expect(screen.getByText("TG @bkk_runners")).toBeInTheDocument();

    await user.click(screen.getByTestId("community-approve-5"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe("/api/admin/community/activities/5/approve");

    await user.click(screen.getByTestId("community-reject-5"));
    await user.click(await screen.findByTestId("community-reject-confirm"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ path: "/api/admin/community/activities/5/reject", body: { code: "R01" } });
  });

  it("已发布的可以冻结（原因必填），冻结的可以解冻", async () => {
    const posted: { path: string; body: unknown }[] = [];
    renderAdminApp("/community", {
      "GET /api/admin/me": () => jsonResponse(200, ops),
      "GET /api/admin/community/activities": () =>
        jsonResponse(200, { items: [row({ status: "PUBLISHED" }), row({ id: 6, title: "Frozen run", status: "PUBLISHED", frozen: true }, { freezeReason: "Reported" })] }),
      "POST /api/admin/community/activities/5/freeze": async (request) => {
        posted.push({ path: new URL(request.url).pathname, body: await request.json() });
        return jsonResponse(200, row({ frozen: true }));
      },
      "POST /api/admin/community/activities/6/unfreeze": (request) => {
        posted.push({ path: new URL(request.url).pathname, body: null });
        return jsonResponse(200, row());
      },
    });
    const user = setupFormUser();
    expect(await screen.findByText("Taken down · Reported")).toBeInTheDocument();
    await user.click(screen.getByTestId("community-freeze-5"));
    expect(await screen.findByTestId("community-freeze-confirm")).toBeDisabled();
    await user.type(screen.getByTestId("community-freeze-reason"), "Unsafe route");
    await user.click(screen.getByTestId("community-freeze-confirm"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ path: "/api/admin/community/activities/5/freeze", body: { reason: "Unsafe route" } });
    await user.click(screen.getByTestId("community-unfreeze-6"));
    await waitFor(() => expect(posted).toHaveLength(2));
  });

  it("管理员只读：看得到，没有审核按钮", async () => {
    renderAdminApp("/community", {
      "GET /api/admin/me": () => jsonResponse(200, admin),
      "GET /api/admin/community/activities": () => jsonResponse(200, { items: [row()] }),
    });
    expect(await screen.findByText("Night run · Riverside 8K")).toBeInTheDocument();
    expect(screen.queryByTestId("community-approve-5")).not.toBeInTheDocument();
  });
});
