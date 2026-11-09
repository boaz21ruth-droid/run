import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schemas } from "@werun/api-client";
import { beforeEach, describe, expect, it } from "vitest";
import { apiRoutes, halfMarathon, jsonResponse } from "../test/fixtures";
import { inTelegram, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";
import { pasteInto } from "../test/userInput";

const SLUG = halfMarathon.slug;
const PATH = `/events/${SLUG}/volunteer`;
const role = (id: number, name: string, remaining: number, capacity = 8): Schemas["PublicVolunteerRole"] => ({
  id,
  name,
  schedule: null,
  capacity,
  remaining,
});
const info = (patch: Partial<Schemas["AppVolunteerInfo"]> = {}): Schemas["AppVolunteerInfo"] => ({
  open: true,
  dates: ["2026-11-13", "2026-11-15"],
  note: "Khmer and English · T-shirt and meals",
  roles: [role(1, "Check-in", 3), role(2, "Bib pickup", 0), role(3, "Course marshal", 6), role(4, "Water station", 2)],
  application: null,
  ...patch,
});
const application = (patch: Partial<Schemas["VolunteerApplication"]> = {}): Schemas["VolunteerApplication"] => ({
  id: 9,
  status: "PENDING",
  fullAvailability: true,
  dates: [],
  roleIds: [1, 3],
  assignedRoleName: null,
  reviewNote: null,
  createdAt: "2026-11-01T03:00:00Z",
  ...patch,
});

function routes(current: () => Schemas["AppVolunteerInfo"], extra: Parameters<typeof runnerRoutes>[0] = {}) {
  return runnerRoutes({
    [`GET /api/events/${SLUG}`]: () => jsonResponse(200, { ...halfMarathon, volunteerOpen: true }),
    [`GET /api/app/events/${SLUG}/volunteer`]: () => jsonResponse(200, current()),
    ...extra,
  });
}

describe("志愿者报名", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("赛事在招志愿者时显示入口", async () => {
    renderApp(`/events/${SLUG}`, apiRoutes({ [`GET /api/events/${SLUG}`]: () => jsonResponse(200, { ...halfMarathon, volunteerOpen: true }) }));
    expect(await screen.findByTestId("volunteer-link")).toHaveAttribute("href", PATH);
  });

  it("岗位显示实时席位与满员候补，最多选 3 个；缺项时逐条提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routes(() => info()), inTelegram);
    expect(await screen.findByText("Khmer and English · T-shirt and meals")).toBeInTheDocument();
    expect(screen.getByTestId("volunteer-role-2")).toHaveTextContent("Full · waitlist");
    expect(screen.getByTestId("volunteer-role-1")).toHaveTextContent("3seats");

    for (const id of [1, 2, 3]) {
      await user.click(within(screen.getByTestId(`volunteer-role-${id}`)).getByRole("checkbox"));
    }
    expect(within(screen.getByTestId("volunteer-role-4")).getByRole("checkbox")).toBeDisabled();
    expect(screen.getByText("Live seats · 3 picked")).toBeInTheDocument();

    await user.click(screen.getByTestId("volunteer-partial"));
    await user.click(screen.getByTestId("volunteer-submit"));
    expect(screen.getByText("Pick at least one day.")).toBeInTheDocument();
    expect(screen.getByText("Tick the code of conduct and the seats note.")).toBeInTheDocument();
    expect(screen.getByText("Enter a phone number with country code, e.g. +855 12 345 678.")).toBeInTheDocument();
  });

  it("提交：部分日期、选的岗位、可选的影像同意；提交后显示待安排", async () => {
    const user = userEvent.setup();
    let current = info();
    let sent: unknown = null;
    renderApp(
      PATH,
      routes(() => current, {
        [`POST /api/app/events/${SLUG}/volunteer`]: async (request) => {
          sent = await request.json();
          current = info({ application: application({ fullAvailability: false, dates: ["2026-11-15"], roleIds: [4] }) });
          return jsonResponse(201, current.application);
        },
      }),
      inTelegram,
    );
    await user.click(await screen.findByTestId("volunteer-partial"));
    await user.click(screen.getByTestId("volunteer-date-2026-11-15"));
    await user.click(within(screen.getByTestId("volunteer-role-4")).getByRole("checkbox"));
    await pasteInto(user, screen.getByTestId("volunteer-name"), " Sok Dara ");
    await pasteInto(user, screen.getByTestId("volunteer-phone"), "+855 12 345 678");
    await user.click(screen.getByTestId("volunteer-agree-conduct"));
    await user.click(screen.getByTestId("volunteer-agree-seats"));
    await user.click(screen.getByTestId("volunteer-submit"));

    expect(await screen.findByTestId("volunteer-status")).toHaveAttribute("data-status", "PENDING");
    expect(sent).toEqual({
      fullName: "Sok Dara",
      phone: "+855 12 345 678",
      fullAvailability: false,
      dates: ["2026-11-15"],
      roleIds: [4],
      mediaConsent: false,
      conductAccepted: true,
    });
    expect(screen.getByTestId("volunteer-status")).toHaveTextContent("Water station");
  });

  it("已安排显示岗位，撤回要确认", async () => {
    const user = userEvent.setup();
    let current = info({ application: application({ status: "ASSIGNED", assignedRoleName: "Check-in" }) });
    let withdrawn = false;
    renderApp(
      PATH,
      routes(() => current, {
        [`POST /api/app/events/${SLUG}/volunteer/withdraw`]: () => {
          withdrawn = true;
          current = info({ application: application({ status: "WITHDRAWN" }) });
          return jsonResponse(200, current.application);
        },
      }),
      inTelegram,
    );
    expect(await screen.findByTestId("volunteer-assigned")).toHaveTextContent("Your role: Check-in");
    await user.click(screen.getByTestId("volunteer-withdraw"));
    expect(withdrawn).toBe(false);
    await user.click(screen.getByTestId("volunteer-withdraw-confirm"));
    await waitFor(() => expect(withdrawn).toBe(true));
    expect(await screen.findByTestId("volunteer-submit")).toBeInTheDocument();
  });

  it("未安排显示原因，可以重新申请", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routes(() => info({ application: application({ status: "REJECTED", reviewNote: "Enough people this time." }) })), inTelegram);
    expect(await screen.findByTestId("volunteer-rejected")).toHaveTextContent("Enough people this time.");
    await user.click(screen.getByRole("button", { name: "Apply again" }));
    expect(screen.getByTestId("volunteer-submit")).toBeInTheDocument();
  });

  it("不招志愿者", async () => {
    renderApp(PATH, routes(() => info({ open: false })), inTelegram);
    expect(await screen.findByTestId("volunteer-closed")).toBeInTheDocument();
  });
});
