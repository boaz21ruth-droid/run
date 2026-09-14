import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, earlyCoupon, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { fillField, replaceField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function findRequest(requests: Request[], method: string, pathname: string): Request | undefined {
  return requests.find((request) => request.method === method && new URL(request.url).pathname === pathname);
}

async function openCouponsTab(user: ReturnType<typeof setupFormUser>) {
  await user.click(await screen.findByTestId("event-tab-coupons"));
}

describe("优惠码标签页", () => {
  it("OPS 新建百分比优惠码：代码转大写并绑定当前赛事", async () => {
    let created = false;
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () =>
        jsonResponse(200, { items: created ? [{ ...earlyCoupon, usedCount: 0, reservedCount: 0 }] : [] }),
      "POST /api/admin/coupons": () => {
        created = true;
        return jsonResponse(201, earlyCoupon);
      },
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-create"));
    await fillField(user, "coupon_code", "early_2026");
    await fillField(user, "coupon_discountValue", "20");
    await fillField(user, "coupon_quota", "50");
    await fillField(user, "coupon_minRunners", "2");
    await user.click(screen.getByTestId("coupon-submit"));

    const row = await screen.findByTestId("coupon-row-EARLY_2026");
    expect(within(row).getByText("20%")).toBeInTheDocument();
    const list = findRequest(requests, "GET", "/api/admin/coupons");
    expect(new URL(list!.url).searchParams.get("eventId")).toBe("7");
    expect(await findRequest(requests, "POST", "/api/admin/coupons")?.clone().json()).toEqual({
      code: "EARLY_2026",
      eventId: 7,
      discountType: "PERCENT",
      discountValue: 20,
      quota: 50,
      minRunners: 2,
      validFrom: null,
      validUntil: null,
      status: "ACTIVE",
    });
  });

  it("百分比超出范围时不提交", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [] }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-create"));
    await fillField(user, "coupon_code", "BIG_DEAL");
    await fillField(user, "coupon_discountValue", "150");
    await fillField(user, "coupon_quota", "5");
    await user.click(screen.getByTestId("coupon-submit"));

    expect(await screen.findByText("Enter a whole number from 1 to 100")).toBeInTheDocument();
    expect(findRequest(requests, "POST", "/api/admin/coupons")).toBeUndefined();
  });

  it("代码重复：服务端字段错误显示在代码输入框下", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [] }),
      "POST /api/admin/coupons": () =>
        jsonResponse(409, {
          error: {
            code: "COUPON_CODE_TAKEN",
            message: "This coupon code already exists.",
            fields: { code: "This coupon code already exists." },
          },
        }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-create"));
    await fillField(user, "coupon_code", "EARLY_2026");
    await fillField(user, "coupon_discountValue", "10");
    await fillField(user, "coupon_quota", "5");
    await user.click(screen.getByTestId("coupon-submit"));

    expect(await screen.findByText("This coupon code already exists.")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-submit")).toBeInTheDocument();
  });

  it("编辑：代码不可改，请求体不含代码", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [earlyCoupon] }),
      "PUT /api/admin/coupons/41": () => jsonResponse(200, { ...earlyCoupon, quota: 60 }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);
    await user.click(await screen.findByTestId("coupon-edit-EARLY_2026"));
    expect(document.querySelector("#coupon_code")).toBeDisabled();
    await replaceField(user, "coupon_quota", "60");
    await user.click(screen.getByTestId("coupon-submit"));

    expect(await screen.findByText("Coupon saved")).toBeInTheDocument();
    expect(await findRequest(requests, "PUT", "/api/admin/coupons/41")?.clone().json()).toEqual({
      eventId: 7,
      discountType: "PERCENT",
      discountValue: 20,
      quota: 60,
      minRunners: 2,
      validFrom: null,
      validUntil: "2026-10-31T16:59:00.000Z",
      status: "ACTIVE",
    });
  });

  it("ADMIN 只读：没有新建与编辑按钮", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/coupons": () => jsonResponse(200, { items: [earlyCoupon] }),
    });
    const user = setupFormUser();

    await openCouponsTab(user);

    expect(await screen.findByTestId("coupon-row-EARLY_2026")).toBeInTheDocument();
    expect(screen.queryByTestId("coupon-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coupon-edit-EARLY_2026")).not.toBeInTheDocument();
  });
});
