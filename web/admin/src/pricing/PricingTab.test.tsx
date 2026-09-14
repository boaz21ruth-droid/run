import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, earlyBirdRule, jsonResponse, opsMe, publishedEvent } from "../test/fixtures";
import { fillField, replaceField, setupFormUser } from "../test/form";
import { renderAdminApp } from "../test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

function findRequest(requests: Request[], method: string, pathname: string): Request | undefined {
  return requests.find((request) => request.method === method && new URL(request.url).pathname === pathname);
}

describe("价格档标签页", () => {
  it("OPS 新建价格档：请求体为分，默认关联全部组别，成功后列表出现新行", async () => {
    let created = false;
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: created ? [earlyBirdRule] : [] }),
      "POST /api/admin/events/7/price-rules": () => {
        created = true;
        return jsonResponse(201, earlyBirdRule);
      },
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));
    await user.click(await screen.findByTestId("price-rule-create"));
    await fillField(user, "priceRule_name_zh", "早鸟价");
    await fillField(user, "priceRule_name_en", "Early bird");
    await fillField(user, "priceRule_name_km", "តម្លៃទិញមុន");
    await fillField(user, "priceRule_priceUsd", "25");
    await fillField(user, "priceRule_quota", "100");
    await replaceField(user, "priceRule_sortOrder", "1");
    await user.click(screen.getByTestId("price-rule-submit"));

    const row = await screen.findByTestId("price-rule-row-31");
    expect(within(row).getByText("$25.00")).toBeInTheDocument();
    expect(within(row).getByText("21K")).toBeInTheDocument();
    const post = findRequest(requests, "POST", "/api/admin/events/7/price-rules");
    expect(post?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await post?.clone().json()).toEqual({
      name: { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន" },
      audience: "ALL",
      priceCents: 2500,
      quota: 100,
      saleStartsAt: null,
      saleEndsAt: null,
      sortOrder: 1,
      categoryIds: [11],
    });
  });

  it("价格格式不对时不提交", async () => {
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: [] }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));
    await user.click(await screen.findByTestId("price-rule-create"));
    await fillField(user, "priceRule_name_zh", "早鸟价");
    await fillField(user, "priceRule_name_en", "Early bird");
    await fillField(user, "priceRule_name_km", "តម្លៃទិញមុន");
    await fillField(user, "priceRule_priceUsd", "25.505");
    await user.click(screen.getByTestId("price-rule-submit"));

    expect(await screen.findByText("Enter an amount such as 25 or 25.50")).toBeInTheDocument();
    expect(findRequest(requests, "POST", "/api/admin/events/7/price-rules")).toBeUndefined();
  });

  it("已有占用的价格档：价格、人群、组别不可编辑，仍可改名称", async () => {
    const taken = { ...earlyBirdRule, reservedCount: 3 };
    const { requests } = renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: [taken] }),
      "PUT /api/admin/price-rules/31": () =>
        jsonResponse(200, { ...taken, name: { ...taken.name, en: "Early bird (extended)" } }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));
    await user.click(await screen.findByTestId("price-rule-edit-31"));

    expect(await screen.findByText("This tier already has registrations. Price, audience and categories are locked.")).toBeInTheDocument();
    expect(document.querySelector("#priceRule_priceUsd")).toBeDisabled();
    expect(document.querySelector("#priceRule_audience")?.closest(".ant-select")).toHaveClass("ant-select-disabled");
    expect(document.querySelector("#priceRule_categoryIds")?.closest(".ant-select")).toHaveClass("ant-select-disabled");

    await replaceField(user, "priceRule_name_en", "Early bird (extended)");
    await user.click(screen.getByTestId("price-rule-submit"));

    expect(await screen.findByText("Price tier saved")).toBeInTheDocument();
    const put = findRequest(requests, "PUT", "/api/admin/price-rules/31");
    expect(await put?.clone().json()).toMatchObject({
      name: { zh: "早鸟价", en: "Early bird (extended)", km: "តម្លៃទិញមុន" },
      audience: "ALL",
      priceCents: 2500,
      categoryIds: [11],
    });
  });

  it("ADMIN 只读：能看价格档，没有新建与编辑按钮", async () => {
    renderAdminApp("/events/7", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events/7": () => jsonResponse(200, publishedEvent),
      "GET /api/admin/events/7/price-rules": () => jsonResponse(200, { items: [earlyBirdRule] }),
    });
    const user = setupFormUser();

    await user.click(await screen.findByTestId("event-tab-pricing"));

    expect(await screen.findByTestId("price-rule-row-31")).toBeInTheDocument();
    expect(screen.queryByTestId("price-rule-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("price-rule-edit-31")).not.toBeInTheDocument();
  });
});
