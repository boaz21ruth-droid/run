import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { apiRoutes, jsonResponse } from "../test/fixtures";
import { inTelegram, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { pasteInto } from "../test/userInput";

const club: Schemas["CommunityFeedItem"] = {
  kind: "CLUB",
  id: 5,
  eventSlug: null,
  title: "Wednesday night run · Riverside 8K",
  startsAt: "2026-11-11T12:00:00Z",
  city: "Phnom Penh",
  location: "Riverside",
  hostName: "BKK Runners",
  tag: "NIGHT",
  distanceText: "8K · 6:00–6:30",
  capacity: 10,
  joinedCount: 5,
  waitlistCount: 0,
  feeNote: "Free",
  coverUrl: null,
  joinerInitials: ["RK", "NP"],
};
const official: Schemas["CommunityFeedItem"] = {
  ...club,
  kind: "OFFICIAL",
  id: 9,
  eventSlug: "sat-run",
  title: "Saturday run · Koh Pich",
  hostName: "",
  tag: null,
  distanceText: null,
  capacity: 100,
  joinedCount: 64,
  feeNote: null,
  joinerInitials: [],
};
const feed = (patch: Partial<Schemas["CommunityFeed"]> = {}): Schemas["CommunityFeed"] => ({
  items: [official, club],
  checkins: [{ name: "Dara", initials: "SD" }],
  cities: ["Phnom Penh"],
  ...patch,
});
const activity = (patch: Partial<Schemas["CommunityActivity"]> = {}): Schemas["CommunityActivity"] => ({
  id: 5,
  title: club.title,
  tag: "NIGHT",
  startsAt: "2099-11-11T12:00:00Z",
  city: "Phnom Penh",
  location: "Riverside",
  meetPoint: "Independence Monument, north side",
  distanceText: "8K",
  capacity: 2,
  joinedCount: 1,
  waitlistCount: 0,
  feeNote: "Free",
  hostName: "BKK Runners",
  authorName: "Rithy",
  body: "Coconut water after.",
  contactVisibility: "JOINED",
  status: "PUBLISHED",
  rejectCode: null,
  frozen: false,
  joinerInitials: ["RK"],
  ...patch,
});
const view = (patch: Partial<Schemas["CommunityActivityView"]> = {}): Schemas["CommunityActivityView"] => ({
  activity: activity(),
  myStatus: "NONE",
  isAuthor: false,
  contact: null,
  ...patch,
});

describe("跑团页", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("混排官方免费与跑团活动，筛选按类型请求；未登录不显示「我在」", async () => {
    const user = userEvent.setup();
    const kinds: (string | null)[] = [];
    renderApp(
      "/community",
      apiRoutes({
        "GET /api/community/feed": (request) => {
          const kind = new URL(request.url).searchParams.get("kind");
          kinds.push(kind);
          return jsonResponse(200, kind === "CLUB" ? feed({ items: [club] }) : feed());
        },
      }),
      { initData: null },
    );
    const officialCard = await screen.findByTestId("community-official-9");
    expect(officialCard).toHaveTextContent("WeRun official");
    expect(within(officialCard).getByRole("link", { name: "Sign up free" })).toHaveAttribute("href", "/events/sat-run");
    const clubCard = screen.getByTestId("community-club-5");
    expect(clubCard).toHaveTextContent("BKK Runners");
    expect(clubCard).toHaveTextContent("5 / 10");
    expect(screen.getByTestId("community-open-5")).toHaveAttribute("href", "/community/5");
    expect(screen.getByText("Dara")).toBeInTheDocument();
    expect(screen.queryByTestId("community-checkin")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("community-filter-CLUB"));
    await waitFor(() => expect(screen.queryByTestId("community-official-9")).not.toBeInTheDocument());
    expect(kinds).toContain("CLUB");
  });

  it("满员的跑团活动显示候补；登录后可以签到「我在」", async () => {
    const user = userEvent.setup();
    let checkedIn = false;
    renderApp(
      "/community",
      runnerRoutes({
        "GET /api/community/feed": () => jsonResponse(200, feed({ items: [{ ...club, joinedCount: 10, waitlistCount: 3 }] })),
        "GET /api/app/community/checkin": () => jsonResponse(200, { checkedIn, checkins: [] }),
        "POST /api/app/community/checkin": () => {
          checkedIn = true;
          return jsonResponse(200, { checkedIn: true, checkins: [{ name: "Runner", initials: "RU" }] });
        },
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("community-club-5")).toHaveTextContent("Full · 3 waiting");
    expect(screen.getByTestId("community-open-5")).toHaveTextContent("Waitlist");
    await user.click(await screen.findByTestId("community-checkin"));
    await waitFor(() => expect(screen.getByTestId("community-checkin")).toHaveAttribute("aria-pressed", "true"));
    expect(checkedIn).toBe(true);
  });

  it("活动详情：参加后显示联系方式，可以退出；满员时按钮变候补", async () => {
    const user = userEvent.setup();
    let current = view();
    renderApp(
      "/community/5",
      runnerRoutes({
        "GET /api/app/community/activities/5/me": () => jsonResponse(200, current),
        "POST /api/app/community/activities/5/join": () => {
          current = view({ myStatus: "JOINED", contact: { telegram: "bkk_runners", phone: null }, activity: activity({ joinedCount: 2 }) });
          return jsonResponse(200, current);
        },
        "POST /api/app/community/activities/5/leave": () => {
          current = view();
          return jsonResponse(200, current);
        },
      }),
      inTelegram,
    );
    expect(await screen.findByText("You'll see the host's contact after you join.")).toBeInTheDocument();
    await user.click(screen.getByTestId("community-join"));
    expect(await screen.findByTestId("community-contact")).toHaveTextContent("@bkk_runners");
    expect(screen.getByRole("link", { name: "@bkk_runners" })).toHaveAttribute("href", "https://t.me/bkk_runners");
    expect(screen.getByTestId("community-my-status")).toHaveAttribute("data-status", "JOINED");
    await user.click(screen.getByTestId("community-leave"));
    expect(await screen.findByTestId("community-join")).toHaveTextContent("Join");
  });

  it("发起人看到审核状态并可取消", async () => {
    const user = userEvent.setup();
    let closed = false;
    renderApp(
      "/community/5",
      runnerRoutes({
        "GET /api/app/community/activities/5/me": () =>
          jsonResponse(200, view({ isAuthor: true, contact: { telegram: "bkk_runners", phone: null }, activity: activity({ status: "REVIEWING" }) })),
        "POST /api/app/community/activities/5/close": () => {
          closed = true;
          return jsonResponse(200, view({ isAuthor: true, activity: activity({ status: "CLOSED" }) }));
        },
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("community-author-status")).toHaveTextContent("In review");
    expect(screen.queryByTestId("community-join")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("community-close"));
    await user.click(screen.getByTestId("community-close-confirm"));
    await waitFor(() => expect(closed).toBe(true));
    expect(await screen.findByTestId("community-author-status")).toHaveAttribute("data-status", "CLOSED");
  });

  it("满员时参加按钮提示进候补", async () => {
    renderApp(
      "/community/5",
      runnerRoutes({ "GET /api/app/community/activities/5/me": () => jsonResponse(200, view({ activity: activity({ joinedCount: 2 }) })) }),
      inTelegram,
    );
    expect(await screen.findByTestId("community-join")).toHaveTextContent("Full · join the waitlist");
  });

  it("发布活动：校验必填与免责声明，提交后进入活动页", async () => {
    const user = userEvent.setup();
    let sent: Schemas["CreateCommunityActivity"] | null = null;
    const { router } = renderApp(
      "/community/new",
      runnerRoutes({
        "GET /api/app/consents": () =>
          jsonResponse(200, {
            version: "UGC-v1",
            lang: "en",
            effectiveDate: "2026-01-01",
            fullText: "Run at your own risk.",
            items: [{ key: "safety", title: "I run at my own risk", description: "", optional: false }],
          }),
        "POST /api/app/community/activities": async (request) => {
          sent = (await request.json()) as Schemas["CreateCommunityActivity"];
          return jsonResponse(201, activity({ id: 77, status: "REVIEWING" }));
        },
        "GET /api/app/community/activities/77/me": () => jsonResponse(200, view({ isAuthor: true, activity: activity({ id: 77, status: "REVIEWING" }) })),
      }),
      inTelegram,
    );
    await user.click(await screen.findByTestId("community-submit"));
    expect(screen.getByText("Tick the disclaimer.")).toBeInTheDocument();
    expect(screen.getByText("Leave a Telegram username or phone number.")).toBeInTheDocument();
    expect(sent).toBeNull();

    await pasteInto(user, screen.getByTestId("community-title"), "Night run");
    await user.click(screen.getByRole("radio", { name: "Night run" }));
    fireEvent.change(screen.getByTestId("community-startsAt"), { target: { value: "2099-11-11T19:00" } });
    await pasteInto(user, screen.getByTestId("community-location"), "Riverside");
    await pasteInto(user, screen.getByTestId("community-meetPoint"), "Monument");
    await pasteInto(user, screen.getByTestId("community-contactTelegram"), "@bkk_runners");
    await pasteInto(user, screen.getByTestId("community-body"), "Easy pace.");
    await user.click(screen.getByTestId("community-consent-safety"));
    await user.click(screen.getByTestId("community-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/community/77"));
    expect(sent).toMatchObject({
      title: "Night run",
      tag: "NIGHT",
      city: "Phnom Penh",
      location: "Riverside",
      meetPoint: "Monument",
      capacity: 10,
      contactTelegram: "@bkk_runners",
      contactVisibility: "JOINED",
      body: "Easy pace.",
      consent: { version: "UGC-v1", lang: "en", checkedItems: ["safety"] },
    });
    expect(sent!.startsAt).toBe(new Date("2099-11-11T19:00").toISOString());
  });

  it("「我的」页有常用参赛人与我发布的跑团活动入口（底部标签栏改成跑团后）", async () => {
    renderApp("/me", runnerRoutes({}), inTelegram);
    expect(await screen.findByTestId("me-profiles")).toHaveAttribute("href", "/profiles");
    expect(screen.getByTestId("me-community")).toHaveAttribute("href", "/community/mine");
  });
});
