import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { freeActivity } from "../test/freeFixtures";
import { renderApp } from "../test/renderApp";

describe("EventDetailPage 免费报名入口", () => {
  it("免费活动开放报名时显示免费报名按钮并链接到报名页", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp(`/events/${freeActivity.slug}`, async () => jsonResponse(200, freeActivity));

    const button = await screen.findByTestId("free-signup-button");
    expect(button).toHaveAttribute("href", `/events/${freeActivity.slug}/free-signup`);
    expect(button).toHaveTextContent("Sign up for free");
    expect(screen.queryByTestId("register-button")).not.toBeInTheDocument();
  });

  it("未开放报名时不显示免费报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp(`/events/${freeActivity.slug}`, async () => jsonResponse(200, { ...freeActivity, registrationOpen: false }));

    expect(await screen.findByRole("heading", { name: "Riverside Fun Walk" })).toBeInTheDocument();
    expect(screen.queryByTestId("free-signup-button")).not.toBeInTheDocument();
  });

  it("付费赛事不显示免费报名按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp(`/events/${freeActivity.slug}`, async () => jsonResponse(200, { ...freeActivity, eventType: "RACE" }));

    expect(await screen.findByRole("heading", { name: "Riverside Fun Walk" })).toBeInTheDocument();
    expect(screen.queryByTestId("free-signup-button")).not.toBeInTheDocument();
  });
});
