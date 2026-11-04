import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { loadReferral } from "../promo/referral";
import { apiRoutes, halfMarathon, jsonResponse } from "../test/fixtures";
import { inTelegram, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { pasteInto } from "../test/userInput";

const SLUG = halfMarathon.slug;
const visit: Schemas["ReferralVisit"] = {
  eventSlug: SLUG,
  label: "BKK Runners",
  kind: "CLUB",
  couponCode: "NEAK-BKK",
  offer: { discountType: "PRICE", discountValue: 1800 },
};

function compRequest(patch: Partial<Schemas["CompRequest"]> = {}): Schemas["CompRequest"] {
  return {
    id: 5,
    status: "PENDING",
    kind: "KOL",
    applicantName: "Sreyleak K.",
    profileUrl: "https://instagram.com/sreyleak",
    audience: null,
    note: null,
    couponCode: null,
    reviewNote: null,
    createdAt: "2026-11-01T03:00:00Z",
    ...patch,
  };
}

describe("推荐链接与免费入场", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("打开 /r/<slug>：只计一次点击，记下推荐码，换成赛事页并显示推荐提示", async () => {
    let visits = 0;
    const { router } = renderApp(
      "/r/bkk",
      apiRoutes({
        "POST /api/referrals/bkk/visit": () => {
          visits++;
          return jsonResponse(200, visit);
        },
        [`GET /api/events/${SLUG}`]: () => jsonResponse(200, halfMarathon),
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/events/${SLUG}`));
    const banner = await screen.findByTestId("referral-banner");
    expect(banner).toHaveTextContent("Referred by BKK Runners");
    expect(banner).toHaveTextContent("NEAK-BKK");
    expect(banner).toHaveTextContent("Referral price $18.00 per runner");
    expect(screen.getByTestId("register-button")).toHaveTextContent("Referral price");
    expect(screen.getByTestId("register-button")).toHaveTextContent("$18.00");
    expect(visits).toBe(1);
    expect(loadReferral(SLUG)?.slug).toBe("bkk");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("推荐链接无效时提示，仍可去看赛事", async () => {
    renderApp(
      "/r/ghost",
      apiRoutes({ "POST /api/referrals/ghost/visit": () => jsonResponse(404, { error: { code: "NOT_FOUND", message: "Not found" } }) }),
    );
    expect(await screen.findByText("Referral link not valid")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse all events" })).toHaveAttribute("href", "/events");
    expect(loadReferral(SLUG)).toBeNull();
  });

  it("赛事开放免费入场申请时显示入口", async () => {
    renderApp(`/events/${SLUG}`, apiRoutes({ [`GET /api/events/${SLUG}`]: () => jsonResponse(200, { ...halfMarathon, compOpen: true }) }));
    expect(await screen.findByTestId("comp-link")).toHaveAttribute("href", `/events/${SLUG}/comp`);
  });

  it("提交申请：校验姓名，请求体正确，提交后显示审核中", async () => {
    const user = userEvent.setup();
    let current: Schemas["CompRequest"] | null = null;
    let sent: unknown = null;
    renderApp(
      `/events/${SLUG}/comp`,
      runnerRoutes({
        [`GET /api/events/${SLUG}`]: () => jsonResponse(200, { ...halfMarathon, compOpen: true }),
        [`GET /api/app/events/${SLUG}/comp-request`]: () => jsonResponse(200, { open: true, request: current }),
        [`POST /api/app/events/${SLUG}/comp-request`]: async (request) => {
          sent = await request.json();
          current = compRequest();
          return jsonResponse(201, current);
        },
      }),
      inTelegram,
    );
    await user.click(await screen.findByTestId("comp-submit"));
    expect(await screen.findByText("Enter your name or handle.")).toBeInTheDocument();
    expect(sent).toBeNull();

    await user.click(screen.getByTestId("comp-kind-CLUB"));
    await pasteInto(user, screen.getByTestId("comp-name"), "  Dara M. ");
    await pasteInto(user, screen.getByTestId("comp-url"), "https://t.me/grcrun");
    await user.click(screen.getByTestId("comp-submit"));

    expect(await screen.findByTestId("comp-pending")).toHaveTextContent("In review");
    expect(sent).toEqual({ applicantName: "Dara M.", kind: "CLUB", profileUrl: "https://t.me/grcrun" });
  });

  it("已批准：显示免费码，「用免费码报名」带上码", async () => {
    renderApp(
      `/events/${SLUG}/comp`,
      runnerRoutes({
        [`GET /api/events/${SLUG}`]: () => jsonResponse(200, halfMarathon),
        [`GET /api/app/events/${SLUG}/comp-request`]: () =>
          jsonResponse(200, { open: false, request: compRequest({ status: "APPROVED", couponCode: "COMP-7K2M9QXA" }) }),
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("comp-code")).toHaveTextContent("COMP-7K2M9QXA");
    expect(screen.getByTestId("comp-register")).toHaveAttribute("href", `/events/${SLUG}/register?coupon=COMP-7K2M9QXA`);
  });

  it("被拒：显示原因，可以重新申请；不开放时只显示说明", async () => {
    const user = userEvent.setup();
    renderApp(
      `/events/${SLUG}/comp`,
      runnerRoutes({
        [`GET /api/events/${SLUG}`]: () => jsonResponse(200, halfMarathon),
        [`GET /api/app/events/${SLUG}/comp-request`]: () =>
          jsonResponse(200, { open: true, request: compRequest({ status: "REJECTED", reviewNote: "Please use the club code." }) }),
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("comp-rejected")).toHaveTextContent("Please use the club code.");
    await user.click(screen.getByRole("button", { name: "Apply again" }));
    expect(screen.getByTestId("comp-submit")).toBeInTheDocument();
  });
});
