// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_SDK_URL, applyTelegramTheme, initTelegram, isTelegram, type RouterLike, type TelegramWebApp } from "./telegram";

function fakeWebApp(): TelegramWebApp {
  return {
    ready: vi.fn(),
    expand: vi.fn(),
    themeParams: { bg_color: "#ffffff", button_color: "#0f66ae" },
    viewportStableHeight: 640,
    onEvent: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn() },
  };
}

function fakeRouter(pathname: string) {
  let subscriber: ((state: { location: { pathname: string } }) => void) | undefined;
  const router: RouterLike = {
    state: { location: { pathname } },
    subscribe: (fn) => {
      subscriber = fn;
      return () => undefined;
    },
    navigate: vi.fn(async () => undefined),
  };
  return { router, emit: (path: string) => subscriber?.({ location: { pathname: path } }) };
}

afterEach(() => {
  delete window.Telegram;
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

describe("isTelegram", () => {
  it("只在地址带 tgWebAppData 时返回 true", () => {
    expect(isTelegram({ hash: "", search: "" })).toBe(false);
    expect(isTelegram({ hash: "#tgWebAppData=query_id%3DAA", search: "" })).toBe(true);
    expect(isTelegram({ hash: "", search: "?tgWebAppData=abc" })).toBe(true);
  });
});

describe("initTelegram", () => {
  it("不在 Telegram 中时什么都不做，也不加载 SDK", async () => {
    const { router } = fakeRouter("/");
    await expect(initTelegram(router, { hash: "", search: "" })).resolves.toBe(false);
    expect(document.querySelector(`script[src="${TELEGRAM_SDK_URL}"]`)).toBeNull();
  });

  it("在 Telegram 中调用 ready、expand，并同步主题与返回按钮", async () => {
    const webApp = fakeWebApp();
    window.Telegram = { WebApp: webApp };
    const { router, emit } = fakeRouter("/");

    await expect(initTelegram(router, { hash: "#tgWebAppData=abc", search: "" })).resolves.toBe(true);

    expect(webApp.ready).toHaveBeenCalledOnce();
    expect(webApp.expand).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue("--tg-bg-color")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--tg-viewport-height")).toBe("640px");
    expect(webApp.BackButton.hide).toHaveBeenCalled();

    emit("/events");
    expect(webApp.BackButton.show).toHaveBeenCalled();

    const onBack = vi.mocked(webApp.BackButton.onClick).mock.calls[0]![0];
    onBack();
    expect(router.navigate).toHaveBeenCalledWith(-1);
  });
});

describe("applyTelegramTheme", () => {
  it("把 themeParams 的下划线名转换为 CSS 变量", () => {
    const webApp = fakeWebApp();
    applyTelegramTheme(webApp);
    expect(document.documentElement.style.getPropertyValue("--tg-button-color")).toBe("#0f66ae");
  });
});
