import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { daraProfile, halfMarathon, jsonResponse } from "../test/fixtures";
import { consentEn, inTelegram, orderDetail, quoteFor, runnerRoutes } from "../test/orderFixtures";
import { renderApp } from "../test/renderApp";

const PATH = "/events/phnom-penh-half-2026/register";

type Routes = Parameters<typeof runnerRoutes>[0];

function routes(overrides: Routes = {}) {
  return runnerRoutes({
    "GET /api/events/phnom-penh-half-2026": () => jsonResponse(200, halfMarathon),
    "GET /api/app/profiles": () => jsonResponse(200, { items: [daraProfile] }),
    "GET /api/app/consents": () => jsonResponse(200, consentEn),
    "POST /api/app/events/phnom-penh-half-2026/quote": () => jsonResponse(200, quoteFor(1)),
    ...overrides,
  });
}

async function reachConfirmWithSavedProfile(user: UserEvent) {
  await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
  await user.selectOptions(screen.getByTestId("participant-0-profile"), "7");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("participant-0-summary");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("quote-amount");
}

async function checkAllConsents(user: UserEvent) {
  for (const key of ["rules", "health", "terms"]) {
    await user.click(await screen.findByTestId(`consent-item-${key}`));
  }
}

async function fillNewRunner(user: UserEvent, i: number) {
  await user.type(screen.getByTestId(`participant-${i}-fullName`), "Chan Sophea");
  await user.selectOptions(screen.getByTestId(`participant-${i}-gender`), "F");
  fireEvent.change(screen.getByTestId(`participant-${i}-birthDate`), { target: { value: "1990-05-01" } });
  await user.type(screen.getByTestId(`participant-${i}-nationality`), "kh");
  await user.selectOptions(screen.getByTestId(`participant-${i}-idType`), "PASSPORT");
  await user.type(screen.getByTestId(`participant-${i}-idNo`), "N01234567");
  await user.type(screen.getByTestId(`participant-${i}-phone`), "+85512345678");
  await user.type(screen.getByTestId(`participant-${i}-emergencyName`), "Sok Dara");
  await user.type(screen.getByTestId(`participant-${i}-emergencyPhone`), "+85598765432");
  await user.selectOptions(screen.getByTestId(`participant-${i}-tshirtSize`), "M");
}

describe("RegisterPage", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
  });

  it("不在 Telegram 中时显示 open-in-telegram", async () => {
    renderApp(PATH, routes(), { initData: null });
    expect(await screen.findByTestId("open-in-telegram")).toBeInTheDocument();
  });

  it("未开放报名时显示提示", async () => {
    renderApp(
      PATH,
      routes({ "GET /api/events/phnom-penh-half-2026": () => jsonResponse(200, { ...halfMarathon, registrationOpen: false }) }),
      inTelegram,
    );
    expect(await screen.findByTestId("register-closed")).toHaveTextContent("Registration for this event is not open.");
    expect(screen.queryByTestId("wizard-next")).not.toBeInTheDocument();
  });

  it("第 1 步未选组别时提示并停在第 1 步，可添加与移除参赛人", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routes(), inTelegram);

    const category = await screen.findByTestId("participant-0-category");
    expect(screen.getByRole("option", { name: "Half marathon" })).toHaveValue("11");
    expect(category).toHaveValue("");
    await user.click(screen.getByTestId("wizard-next"));

    expect(screen.getByTestId("form-error")).toHaveTextContent("Please check the highlighted fields.");
    expect(screen.getByTestId("participant-0-category-error")).toHaveTextContent("Required.");
    expect(screen.queryByTestId("participant-0-fullName")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("participant-add"));
    expect(screen.getByTestId("participant-1-category")).toBeInTheDocument();
    await user.click(screen.getByTestId("participant-1-remove"));
    expect(screen.queryByTestId("participant-1-category")).not.toBeInTheDocument();
  });

  it("第 2 步复用资料表单校验必填、格式与年龄，通过后按资料算价", async () => {
    const user = userEvent.setup();
    const quoteBodies: unknown[] = [];
    renderApp(
      PATH,
      routes({
        "POST /api/app/events/phnom-penh-half-2026/quote": async (request) => {
          quoteBodies.push(await request.json());
          return jsonResponse(200, quoteFor(1));
        },
      }),
      inTelegram,
    );

    await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
    await user.click(screen.getByTestId("wizard-next"));
    expect(await screen.findByTestId("participant-0-birthDate")).toHaveAttribute("type", "date");
    expect(screen.getByTestId("participant-0-idNo")).toHaveAttribute("maxLength", "32");
    fireEvent.change(screen.getByTestId("participant-0-birthDate"), { target: { value: "2015-01-01" } });
    await user.type(screen.getByTestId("participant-0-phone"), "012345");
    await user.click(screen.getByTestId("wizard-next"));

    expect(screen.getByTestId("form-error")).toHaveTextContent("Please check the highlighted fields.");
    expect(screen.getByTestId("participant-0-birthDate-error")).toHaveTextContent("Must be at least 16 on race day.");
    expect(screen.getByTestId("participant-0-phone-error")).toHaveTextContent("Invalid format.");
    expect(screen.getByTestId("participant-0-fullName-error")).toHaveTextContent("Required.");
    expect(screen.queryByTestId("participant-0-email-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quote-amount")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("participant-0-birthDate"), { target: { value: "" } });
    await user.clear(screen.getByTestId("participant-0-phone"));
    await fillNewRunner(user, 0);
    await user.click(screen.getByTestId("participant-0-saveProfile"));
    await user.click(screen.getByTestId("wizard-next"));

    expect(await screen.findByTestId("quote-amount")).toHaveTextContent("$25.00");
    expect(screen.queryByTestId("form-error")).not.toBeInTheDocument();
    expect(quoteBodies[0]).toEqual({ participants: [{ categoryId: 11, nationality: "KH", birthDate: "1990-05-01" }] });
  });

  it("第 2 步同一订单内证件号重复时提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routes(), inTelegram);

    await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
    await user.click(screen.getByTestId("participant-add"));
    await user.selectOptions(screen.getByTestId("participant-1-category"), "12");
    await user.click(screen.getByTestId("wizard-next"));
    await fillNewRunner(user, 0);
    await fillNewRunner(user, 1);
    await user.click(screen.getByTestId("wizard-next"));

    expect(screen.getByTestId("participant-1-idNo-error")).toHaveTextContent("Another runner in this order has the same ID number.");
    expect(screen.queryByTestId("participant-0-idNo-error")).not.toBeInTheDocument();
  });

  it("算价预估说明不含识别尾数，应用优惠码后显示减免，无效码显示错误且不改金额", async () => {
    const user = userEvent.setup();
    renderApp(
      PATH,
      routes({
        "POST /api/app/events/phnom-penh-half-2026/quote": async (request) => {
          const body = (await request.json()) as { couponCode?: string };
          if (!body.couponCode) {
            return jsonResponse(200, quoteFor(1));
          }
          if (body.couponCode === "RUN20") {
            return jsonResponse(200, quoteFor(1, 500));
          }
          return jsonResponse(422, {
            error: { code: "COUPON_INVALID", message: "This coupon code can't be used.", fields: { couponCode: "This coupon code can't be used." } },
          });
        },
      }),
      inTelegram,
    );
    await reachConfirmWithSavedProfile(user);
    expect(screen.getByTestId("quote-amount")).toHaveTextContent("$25.00");
    expect(screen.getByText("Estimated total")).toBeInTheDocument();
    expect(screen.getByText(/1–50 cents are taken off/)).toBeInTheDocument();

    await user.type(screen.getByTestId("coupon-input"), "nope");
    await user.click(screen.getByTestId("coupon-apply"));
    const invalid = await screen.findByTestId("coupon-result");
    expect(invalid).toHaveAttribute("data-kind", "error");
    expect(invalid).toHaveTextContent("This coupon code can't be used.");
    expect(screen.getByTestId("quote-amount")).toHaveTextContent("$25.00");

    await user.clear(screen.getByTestId("coupon-input"));
    await user.type(screen.getByTestId("coupon-input"), "run20");
    await user.click(screen.getByTestId("coupon-apply"));
    await waitFor(() => expect(screen.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok"));
    expect(screen.getByTestId("coupon-result")).toHaveTextContent("Coupon applied: $5.00 off");
    expect(screen.getByTestId("quote-list-amount")).toHaveTextContent("$25.00");
    expect(screen.getByTestId("quote-discount")).toHaveTextContent("-$5.00");
    expect(screen.getByTestId("quote-amount")).toHaveTextContent("$20.00");
  });

  it("同意书逐项勾选完才能提交", async () => {
    const user = userEvent.setup();
    renderApp(PATH, routes(), inTelegram);
    await reachConfirmWithSavedProfile(user);

    const submit = screen.getByTestId("order-submit");
    expect(submit).toBeDisabled();
    await user.click(await screen.findByTestId("consent-item-rules"));
    await user.click(screen.getByTestId("consent-item-health"));
    expect(submit).toBeDisabled();
    await user.click(screen.getByTestId("consent-item-terms"));
    expect(submit).toBeEnabled();
  });

  it("组别售罄时回到第 1 步并提示，再次进入确认页重新算价", async () => {
    const user = userEvent.setup();
    let quotes = 0;
    renderApp(
      PATH,
      routes({
        "POST /api/app/events/phnom-penh-half-2026/quote": () => {
          quotes += 1;
          return jsonResponse(200, quoteFor(1));
        },
        "POST /api/app/orders": () => jsonResponse(409, { error: { code: "CATEGORY_SOLD_OUT", message: "This category is sold out." } }),
      }),
      inTelegram,
    );
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);
    expect(quotes).toBe(1);

    await user.click(screen.getByTestId("order-submit"));

    expect(await screen.findByTestId("participant-0-category")).toBeInTheDocument();
    expect(screen.getByTestId("form-error")).toHaveTextContent("This category is sold out.");
    expect(screen.queryByTestId("order-submit")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("wizard-next"));
    await user.click(await screen.findByTestId("wizard-next"));
    await screen.findByTestId("quote-amount");
    await waitFor(() => expect(quotes).toBe(2));
  });

  it("服务端返回参赛人字段错误时回到第 2 步显示在对应字段下", async () => {
    const user = userEvent.setup();
    renderApp(
      PATH,
      routes({
        "POST /api/app/orders": () =>
          jsonResponse(409, {
            error: {
              code: "ALREADY_REGISTERED",
              message: "This runner is already registered for the event.",
              fields: { "participants[0].idNo": "Already registered for this event." },
            },
          }),
      }),
      inTelegram,
    );
    await user.selectOptions(await screen.findByTestId("participant-0-category"), "11");
    await user.click(screen.getByTestId("wizard-next"));
    await fillNewRunner(user, 0);
    await user.click(screen.getByTestId("wizard-next"));
    await screen.findByTestId("quote-amount");
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));

    expect(await screen.findByTestId("participant-0-idNo-error")).toHaveTextContent("Already registered for this event.");
    expect(screen.getByTestId("form-error")).toHaveTextContent("This runner is already registered for the event.");
    expect(screen.getByTestId("participant-0-idNo")).toHaveValue("N01234567");
  });

  it("网络失败后重试沿用同一个 Idempotency-Key，成功后进入付款页", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    const bodies: unknown[] = [];
    const { router } = renderApp(
      PATH,
      routes({
        "POST /api/app/orders": async (request) => {
          keys.push(request.headers.get("Idempotency-Key") ?? "");
          bodies.push(await request.json());
          if (keys.length === 1) {
            throw new TypeError("Failed to fetch");
          }
          return jsonResponse(201, orderDetail());
        },
      }),
      inTelegram,
    );
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));
    expect(await screen.findByTestId("form-error")).toHaveTextContent("Network problem. Please check your connection and try again.");
    await user.click(screen.getByTestId("order-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/WR7K2M9QXA/pay"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[0]).toEqual({
      eventSlug: "phnom-penh-half-2026",
      consent: { version: "REG-E2E-v1", lang: "en", checkedItems: ["rules", "health", "terms"] },
      participants: [{ categoryId: 11, profileId: 7 }],
    });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("失败后修改了订单（应用优惠码）再提交时换新的 Idempotency-Key", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    renderApp(
      PATH,
      routes({
        "POST /api/app/events/phnom-penh-half-2026/quote": async (request) => {
          const body = (await request.json()) as { couponCode?: string };
          return jsonResponse(200, quoteFor(1, body.couponCode ? 500 : 0));
        },
        "POST /api/app/orders": (request) => {
          keys.push(request.headers.get("Idempotency-Key") ?? "");
          throw new TypeError("Failed to fetch");
        },
      }),
      inTelegram,
    );
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));
    await screen.findByTestId("form-error");
    await user.type(screen.getByTestId("coupon-input"), "RUN20");
    await user.click(screen.getByTestId("coupon-apply"));
    await waitFor(() => expect(screen.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok"));
    await user.click(screen.getByTestId("order-submit"));

    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("应付为 0 的订单直接进入订单详情", async () => {
    const user = userEvent.setup();
    const paid = orderDetail({ status: "PAID", amountCents: 0, deadlineAt: null });
    const { router } = renderApp(
      PATH,
      routes({
        "POST /api/app/orders": () => jsonResponse(201, paid),
        "GET /api/app/orders/WR7K2M9QXA": () => jsonResponse(200, paid),
      }),
      inTelegram,
    );
    await reachConfirmWithSavedProfile(user);
    await checkAllConsents(user);

    await user.click(screen.getByTestId("order-submit"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/WR7K2M9QXA"));
    expect(await screen.findByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  });
});
