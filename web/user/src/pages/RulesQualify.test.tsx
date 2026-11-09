import { screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../rules/duration";
import { refundRows } from "../rules/RefundPolicyCard";
import { daraProfile, halfMarathon, jsonResponse } from "../test/fixtures";
import { consentEn, inTelegram, orderDetail, quoteFor, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { pasteInto } from "../test/userInput";

const PATH = "/events/phnom-penh-half-2026/register";
const policy: Schemas["RefundPolicy"] = { tiers: [{ days: 14, percent: 80 }, { days: 7, percent: 50 }], transferDays: 3 };
const eliteRule = "Official 21K under 1:45 in the last two years";

// 21K 改成精英组：1:45 以内，不通过转到 10K（测试里拿 10K 当公开组）
const eliteEvent: Schemas["PublicEvent"] = {
  ...halfMarathon,
  refundPolicy: policy,
  categories: halfMarathon.categories.map((c) =>
    c.id === 11 ? { ...c, qualification: { rule: eliteRule, maxTimeMs: 6300000, fallbackCategoryId: 12 } } : c,
  ),
};

const consentWithOptional: Schemas["ConsentVersion"] = {
  ...consentEn,
  items: [...consentEn.items, { key: "results_public", title: "Show my name and time", description: "", optional: true }],
};

function routes(overrides: Parameters<typeof runnerRoutes>[0] = {}) {
  return runnerRoutes({
    "GET /api/events/phnom-penh-half-2026": () => jsonResponse(200, eliteEvent),
    "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
    "GET /api/app/consents": () => jsonResponse(200, consentWithOptional),
    "POST /api/app/events/phnom-penh-half-2026/quote": () => jsonResponse(200, quoteFor(1)),
    ...overrides,
  });
}

async function chooseElite(user: UserEvent) {
  await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
  await user.selectOptions(screen.getByTestId("participant-0-profile"), "7");
}

describe("报名规则与精英组资格", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("成绩格式与退改政策文案", () => {
    expect(parseDuration("1:41:20")).toBe(6080000);
    expect(parseDuration("41:20")).toBe(2480000);
    expect(parseDuration("1:61:20")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(formatDuration(6300000)).toBe("1:45:00");
    const t = (key: string, p?: Record<string, unknown>) => `${key}${p ? JSON.stringify(p) : ""}`;
    expect(refundRows(policy, t).map((r) => [r.when, r.what])).toEqual([
      ['rules.refund.before{"days":14}', 'rules.refund.percent{"percent":80}'],
      ['rules.refund.between{"from":7,"to":14}', 'rules.refund.percent{"percent":50}'],
      ['rules.refund.within{"days":7}', "rules.refund.none"],
      ["rules.refund.transfer", 'rules.refund.transferUntil{"days":3}'],
    ]);
    expect(refundRows({ tiers: [], transferDays: null }, t).map((r) => r.what)).toEqual(["rules.refund.none", "rules.refund.noTransfer"]);
  });

  it("选精英组要填成绩与证明：缺项、超时、链接格式都在第 1 步提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routes(), inTelegram);
    await chooseElite(user);

    const panel = screen.getByTestId("participant-0-qualify");
    expect(panel).toHaveTextContent(eliteRule);
    expect(panel).toHaveTextContent("you'll be moved to Fun run");
    await user.click(screen.getByTestId("wizard-next"));
    expect(within(panel).getAllByText("Required.")).toHaveLength(3);

    await pasteInto(user, screen.getByTestId("participant-0-bestTimeMs"), "1:50:00");
    await pasteInto(user, screen.getByTestId("participant-0-proofSource"), "Mekong Night Run 2025");
    await pasteInto(user, screen.getByTestId("participant-0-proofUrl"), "results.mekong.kh");
    await user.click(screen.getByTestId("wizard-next"));
    expect(panel).toHaveTextContent("You need a time of 1:45:00 or faster for this category.");
    expect(panel).toHaveTextContent("Enter a link starting with https:// or http://.");

    // 换成普通组就不需要证明
    await user.selectOptions(screen.getByTestId("participant-0-category"), "12");
    expect(screen.queryByTestId("participant-0-qualify")).not.toBeInTheDocument();
  });

  it("提交时带上成绩证明；可选条款不勾也能提交，且不计入勾选；确认页显示退改政策", async () => {
    const user = userEvent.setup();
    let sent: Schemas["CreateOrderRequest"] | null = null;
    renderApp(
      PATH,
      routes({
        "POST /api/app/orders": async (request) => {
          sent = (await request.json()) as Schemas["CreateOrderRequest"];
          return jsonResponse(201, orderDetail());
        },
      }),
      inTelegram,
    );
    await chooseElite(user);
    await pasteInto(user, screen.getByTestId("participant-0-bestTimeMs"), "1:41:20");
    await pasteInto(user, screen.getByTestId("participant-0-proofSource"), "  Mekong Night Run 2025 ");
    await pasteInto(user, screen.getByTestId("participant-0-proofUrl"), "https://results.mekong.kh/2025/123");
    await user.click(screen.getByTestId("wizard-next"));
    await screen.findByTestId("participant-0-summary");
    await user.click(screen.getByTestId("wizard-next"));
    await screen.findByTestId("quote-amount");

    const card = screen.getByTestId("refund-policy");
    expect(card).toHaveTextContent("14+ days before");
    expect(card).toHaveTextContent("80% refund");
    expect(card).toHaveTextContent("Within 7 days");
    expect(card).toHaveTextContent("Until 3 days before");
    expect(screen.getByTestId("consent-item-results_public").closest("label")).toHaveTextContent("Optional");

    for (const key of ["rules", "health", "terms"]) {
      await user.click(screen.getByTestId(`consent-item-${key}`));
    }
    expect(screen.getByTestId("order-submit")).toBeEnabled();
    await user.click(screen.getByTestId("order-submit"));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.consent.checkedItems).toEqual(["rules", "health", "terms"]);
    expect(sent!.participants[0]).toEqual({
      categoryId: 11,
      profileId: 7,
      qualification: { bestTimeMs: 6080000, source: "Mekong Night Run 2025", proofUrl: "https://results.mekong.kh/2025/123" },
    });
  });

  it("赛事页显示精英组要求与退改政策", async () => {
    renderApp("/events/phnom-penh-half-2026", routes());
    expect(await screen.findByTestId("category-21K-qualify")).toHaveTextContent(`Elite ${eliteRule}`);
    expect(screen.getByTestId("refund-policy")).toHaveTextContent("Set by organizer");
    expect(screen.queryByTestId("category-10K-qualify")).not.toBeInTheDocument();
  });

  it("订单页显示核验进度与主办方备注", async () => {
    const base = orderDetail({ status: "PAID" });
    const order = orderDetail({
      status: "PAID",
      participants: [
        { ...base.participants[0]!, qualification: { status: "PENDING", appliedCategoryName: { en: "Half marathon" }, reviewNote: null } },
        {
          ...base.participants[1]!,
          categoryName: { en: "Fun run" },
          qualification: { status: "REJECTED", appliedCategoryName: { en: "Half marathon" }, reviewNote: "Result page not found." },
        },
      ],
    });
    renderApp(`/orders/${order.orderNo}`, runnerRoutes({ [`GET /api/app/orders/${order.orderNo}`]: () => jsonResponse(200, order) }), inTelegram);
    expect(await screen.findByTestId("qualify-RG4N8P2QTZ")).toHaveTextContent("Elite entry being checked");
    const rejected = screen.getByTestId("qualify-RG5P9Q3RVW");
    expect(rejected).toHaveTextContent("Not verified, moved from Half marathon");
    expect(rejected).toHaveTextContent("Result page not found.");
  });
});
