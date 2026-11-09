import { screen, waitFor, within } from "@testing-library/react";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { financeMe, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";
import { suggestSlug, userSiteOrigin } from "./PromoTab";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

const link: Schemas["ReferralLink"] = {
  id: 3,
  eventId: 7,
  slug: "bkk",
  label: "BKK Runners",
  kind: "CLUB",
  status: "ACTIVE",
  clickCount: 1240,
  orders: 63,
  paidOrders: 58,
  coupon: { id: 9, code: "NEAK-BKK", discountType: "PRICE", discountValue: 1800, quota: 500, usedCount: 58, reservedCount: 5, status: "ACTIVE" },
  createdAt: "2026-10-01T03:00:00Z",
};

const pending: Schemas["AdminCompRequest"] = {
  id: 11,
  status: "PENDING",
  kind: "KOL",
  applicantName: "Sreyleak K.",
  profileUrl: "https://instagram.com/sreyleak",
  audience: "Instagram 48k",
  note: null,
  couponCode: null,
  reviewNote: null,
  createdAt: "2026-11-01T03:00:00Z",
  userId: 42,
  telegramUsername: "sreyleak",
  couponUsed: false,
  reviewedAt: null,
};

function compList(patch: Partial<Schemas["CompRequestList"]> = {}): Schemas["CompRequestList"] {
  return { quota: 30, approved: 12, pending: 1, items: [pending], ...patch };
}

function routes(extra: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  return {
    "GET /api/admin/me": () => jsonResponse(200, opsMe),
    "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
    "GET /api/admin/events/7/referral-links": () => jsonResponse(200, { items: [link], directOrders: 64, directPaidOrders: 57 }),
    "GET /api/admin/events/7/comp-requests": () => jsonResponse(200, compList()),
    ...extra,
  };
}

describe("推广页", () => {
  it("链接地址与用户站地址", () => {
    expect(suggestSlug("BKK Runners (club)")).toBe("bkk-runners-club");
    expect(suggestSlug("  Telegram 频道 ")).toBe("telegram");
    expect(userSiteOrigin({ protocol: "https:", host: "admin.werun.kh" })).toBe("https://werun.kh");
    expect(userSiteOrigin({ protocol: "http:", host: "localhost:5174" })).toBe("http://localhost:5174");
  });

  it("显示渠道归因：点击、报名、已付、转化，以及直接来的订单", async () => {
    renderAdminApp("/events/7", routes());
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-promo"));

    expect(await screen.findByText("BKK Runners")).toBeInTheDocument();
    const row = screen.getByText("BKK Runners").closest("tr")!;
    expect(within(row).getByText("NEAK-BKK")).toBeInTheDocument();
    expect(within(row).getByText(/\$18\.00 each/)).toBeInTheDocument();
    expect(within(row).getByText("4.7%")).toBeInTheDocument();
    expect(screen.getByTestId("direct-orders")).toHaveTextContent("64");
    expect(screen.getByTestId("comp-summary")).toHaveTextContent("Approved 12 / quota 30 · pending 1");
  });

  it("新建推荐链接：名称自动生成地址与推荐码，按每人固定价提交", async () => {
    let sent: unknown = null;
    renderAdminApp(
      "/events/7",
      routes({
        "POST /api/admin/events/7/referral-links": async (request) => {
          sent = await request.json();
          return jsonResponse(201, { ...link, id: 4, slug: "grc-club", label: "GRC Club" });
        },
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-promo"));
    await user.click(await screen.findByTestId("referral-create"));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Channel name"), "GRC Club");
    expect(within(dialog).getByLabelText("Link address")).toHaveValue("grc-club");
    await user.type(within(dialog).getByLabelText("Discount value"), "18");
    await user.click(screen.getByTestId("referral-submit"));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({
      slug: "grc-club",
      label: "GRC Club",
      kind: "CLUB",
      offer: { code: "GRC-CLUB", discountType: "PRICE", discountValue: 1800, quota: 500 },
    });
  });

  it("批准与拒绝免费入场申请；拒绝时带上原因", async () => {
    const posted: { path: string; body: unknown }[] = [];
    const record = async (request: Request) => {
      const text = await request.text();
      posted.push({ path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
      return jsonResponse(200, { ...pending, status: "APPROVED", couponCode: "COMP-7K2M9QXA" });
    };
    renderAdminApp(
      "/events/7",
      routes({
        "POST /api/admin/comp-requests/11/approve": record,
        "POST /api/admin/comp-requests/11/reject": record,
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-promo"));
    expect(await screen.findByText("Sreyleak K.")).toBeInTheDocument();
    expect(screen.getByText("@sreyleak")).toHaveAttribute("href", "https://t.me/sreyleak");

    await user.click(screen.getByTestId("comp-approve-11"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe("/api/admin/comp-requests/11/approve");

    await user.click(screen.getByTestId("comp-reject-11"));
    await user.type(await screen.findByTestId("comp-reject-note"), "Please use the club code");
    await user.click(screen.getByTestId("comp-reject-confirm"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ path: "/api/admin/comp-requests/11/reject", body: { note: "Please use the club code" } });
  });

  it("设置免费入场名额；关闭申请时提交 null", async () => {
    const quotas: unknown[] = [];
    renderAdminApp(
      "/events/7",
      routes({
        "PUT /api/admin/events/7/comp-quota": async (request) => {
          const body = (await request.json()) as { quota: number | null };
          quotas.push(body.quota);
          return jsonResponse(200, compList({ quota: body.quota }));
        },
      }),
    );
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-promo"));
    const quota = await screen.findByTestId("comp-quota");
    await user.clear(quota);
    await user.type(quota, "40");
    await user.click(screen.getByTestId("comp-quota-save"));
    await waitFor(() => expect(quotas).toEqual([40]));

    await user.click(screen.getByTestId("comp-open"));
    await user.click(await screen.findByTestId("comp-quota-save"));
    await waitFor(() => expect(quotas).toEqual([40, null]));
  });

  it("只读角色看得到数据，但没有新建、审批按钮", async () => {
    renderAdminApp("/events/7", routes({ "GET /api/admin/me": () => jsonResponse(200, financeMe) }));
    const user = setupFormUser();
    await user.click(await screen.findByTestId("event-tab-promo"));
    expect(await screen.findByText("Sreyleak K.")).toBeInTheDocument();
    expect(screen.queryByTestId("referral-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("comp-approve-11")).not.toBeInTheDocument();
    expect(screen.getByTestId("comp-open")).toBeDisabled();
  });
});
