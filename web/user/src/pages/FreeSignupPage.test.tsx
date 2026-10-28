import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonResponse } from "../test/fixtures";
import { freeActivity, presetRunnerSession, registrationConsent, runnerSession } from "../test/freeFixtures";
import { renderApp } from "../test/renderApp";
import { pasteInto } from "../test/userInput";

const PATH = `/events/${freeActivity.slug}/free-signup`;

type PostHandler = (body: unknown) => Response;

function handler(event: unknown, onPost: PostHandler) {
  return async (request: Request) => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/app/auth/telegram":
        return jsonResponse(200, runnerSession);
      case "/api/app/me":
        return jsonResponse(200, runnerSession.user);
      case `/api/events/${freeActivity.slug}`:
        return jsonResponse(200, event);
      case "/api/app/consents":
        return jsonResponse(200, registrationConsent);
      case `/api/app/events/${freeActivity.slug}/free-signups`:
        return onPost(await request.clone().json());
      default:
        return jsonResponse(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    }
  };
}

const created = {
  id: 88,
  signupNo: "FS7K3M9Q2A",
  eventSlug: freeActivity.slug,
  categoryId: 501,
  fullName: "Dara Sok",
  status: "REGISTERED",
  createdAt: "2026-09-14T03:00:00Z",
};

async function fillRequired(user: ReturnType<typeof userEvent.setup>, categoryId: string) {
  await user.selectOptions(await screen.findByTestId("free-category"), categoryId);
  await pasteInto(user, screen.getByTestId("free-fullName"), "Dara Sok");
  await pasteInto(user, screen.getByTestId("free-phone"), "+855 12 345 678");
  await pasteInto(user, screen.getByTestId("free-emergencyName"), "Sok Chan");
  await pasteInto(user, screen.getByTestId("free-emergencyPhone"), "+85598765432");
}

async function checkAllConsents(user: ReturnType<typeof userEvent.setup>) {
  for (const item of registrationConsent.items) {
    await user.click(await screen.findByTestId(`consent-item-${item.key}`));
  }
}

describe("FreeSignupPage", () => {
  beforeEach(() => {
    window.localStorage.setItem("werun.lang", "en");
    presetRunnerSession();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("勾选全部同意书前不能提交；提交成功后显示报名编号，请求体正确", async () => {
    const user = userEvent.setup();
    let sent: unknown = null;
    renderApp(PATH, handler(freeActivity, (body) => {
      sent = body;
      return jsonResponse(201, created);
    }));

    await fillRequired(user, "501");
    expect(screen.getByTestId("free-submit")).toBeDisabled();
    await checkAllConsents(user);
    expect(screen.getByTestId("free-submit")).toBeEnabled();
    await user.click(screen.getByTestId("free-submit"));

    const done = await screen.findByTestId("free-signup-done");
    expect(done).toHaveTextContent("FS7K3M9Q2A");
    expect(sent).toEqual({
      categoryId: 501,
      fullName: "Dara Sok",
      phone: "+85512345678",
      emergencyName: "Sok Chan",
      emergencyPhone: "+85598765432",
      consents: { version: "REG-TEST-v1", lang: "en", checkedItems: ["rules", "health", "terms"] },
    });
  });

  it("必填项为空时提示且不发请求", async () => {
    const user = userEvent.setup();
    let posted = false;
    renderApp(PATH, handler(freeActivity, () => {
      posted = true;
      return jsonResponse(201, created);
    }));

    await checkAllConsents(user);
    await user.click(screen.getByTestId("free-submit"));

    expect(await screen.findAllByText("Required")).toHaveLength(5);
    expect(posted).toBe(false);
  });

  it("已满的组别不可选", async () => {
    renderApp(PATH, handler(freeActivity, () => jsonResponse(201, created)));
    const select = await screen.findByTestId("free-category");
    expect(within(select).getByRole("option", { name: /Sunrise 3K/ })).toBeDisabled();
  });

  it("组别有最低年龄时出生日期必填，年龄不足时提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, handler(freeActivity, () => jsonResponse(201, created)));

    await fillRequired(user, "502");
    await checkAllConsents(user);
    await user.click(screen.getByTestId("free-submit"));
    expect(await screen.findByText("Required")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("free-birthDate"), { target: { value: "2015-01-01" } });
    await user.click(screen.getByTestId("free-submit"));
    expect(await screen.findByText("Must be at least 12 years old on race day")).toBeInTheDocument();
  });

  it("重复报名显示已报名提示", async () => {
    const user = userEvent.setup();
    renderApp(PATH, handler(freeActivity, () =>
      jsonResponse(409, {
        error: { code: "ALREADY_REGISTERED", message: "Already registered", fields: { fullName: "Already signed up" } },
      }),
    ));

    await fillRequired(user, "501");
    await checkAllConsents(user);
    await user.click(screen.getByTestId("free-submit"));

    const formError = await screen.findByTestId("form-error");
    expect(formError).toHaveAttribute("data-code", "ALREADY_REGISTERED");
    expect(formError).toHaveTextContent("This name and phone number are already signed up for this category");
    expect(screen.getByText("Already signed up")).toBeInTheDocument();
    expect(screen.queryByTestId("free-signup-done")).not.toBeInTheDocument();
  });

  it("活动未开放报名时不显示表单", async () => {
    renderApp(PATH, handler({ ...freeActivity, registrationOpen: false }, () => jsonResponse(201, created)));
    expect(await screen.findByText("Registration for this activity is not open")).toBeInTheDocument();
    expect(screen.queryByTestId("free-submit")).not.toBeInTheDocument();
  });

  describe("切换语言", () => {
    function localizedHandler(onPost: PostHandler, consentFor: (lang: string) => unknown = () => registrationConsent) {
      const base = handler(freeActivity, onPost);
      return async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === `/api/events/${freeActivity.slug}`) {
          const zh = request.headers.get("Accept-Language") === "zh";
          return jsonResponse(200, zh ? { ...freeActivity, name: "河畔健步走" } : freeActivity);
        }
        if (url.pathname === "/api/app/consents") {
          return jsonResponse(200, consentFor(url.searchParams.get("lang") ?? ""));
        }
        return base(request);
      };
    }

    it("切换语言后表单不卸载，已填内容与同意勾选保留，可直接提交", async () => {
      const user = userEvent.setup();
      let sent: unknown = null;
      renderApp(
        PATH,
        localizedHandler((body) => {
          sent = body;
          return jsonResponse(201, created);
        }),
      );

      await fillRequired(user, "501");
      await checkAllConsents(user);
      await user.click(screen.getByTestId("lang-switch-zh"));

      expect(await screen.findByText("河畔健步走")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("免费报名");
      expect(screen.getByTestId("free-category")).toHaveValue("501");
      expect(screen.getByTestId("free-fullName")).toHaveValue("Dara Sok");
      expect(screen.getByTestId("free-emergencyPhone")).toHaveValue("+85598765432");
      for (const item of registrationConsent.items) {
        expect(await screen.findByTestId(`consent-item-${item.key}`)).toBeChecked();
      }

      await user.click(screen.getByTestId("free-submit"));
      await screen.findByTestId("free-signup-done");
      // 同意书没有中文版时服务端回退英文：原样提交返回的语言与版本
      expect(sent).toMatchObject({ fullName: "Dara Sok", consents: { version: "REG-TEST-v1", lang: "en" } });
    });

    it("新语言的同意书版本不同时需要重新勾选，填写内容仍保留", async () => {
      const user = userEvent.setup();
      renderApp(
        PATH,
        localizedHandler(
          () => jsonResponse(201, created),
          (lang) => (lang === "zh" ? { ...registrationConsent, version: "REG-TEST-v2", lang: "zh" } : registrationConsent),
        ),
      );

      await fillRequired(user, "501");
      await checkAllConsents(user);
      expect(screen.getByTestId("free-submit")).toBeEnabled();

      await user.click(screen.getByTestId("lang-switch-zh"));

      await waitFor(() => expect(screen.getByTestId("consent-item-rules")).not.toBeChecked());
      expect(screen.getByTestId("free-submit")).toBeDisabled();
      expect(screen.getByTestId("free-fullName")).toHaveValue("Dara Sok");
    });
  });
});
