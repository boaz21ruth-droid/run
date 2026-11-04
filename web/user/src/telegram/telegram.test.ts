// @vitest-environment jsdom
import { createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_SDK_URL,
  applyTelegramTheme,
  initTelegram,
  isTelegram,
  loadTelegramSdk,
  PAPER_COLOR,
  applyStartParam,
  readStartParam,
  startParamTarget,
  type RouterLike,
  type RouterStateLike,
  type TelegramWebApp,
} from "./telegram";

function fakeWebApp(): TelegramWebApp {
  return {
    ready: vi.fn(),
    expand: vi.fn(),
    themeParams: { bg_color: "#ffffff", button_color: "#0f66ae" },
    viewportStableHeight: 640,
    initData: "user=%7B%7D&auth_date=1&hash=abc",
    onEvent: vi.fn(),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn() },
  };
}

function fakeRouter(pathname: string) {
  const subscribers: ((state: RouterStateLike) => void)[] = [];
  let seq = 0;
  const router: RouterLike = {
    state: { location: { pathname, key: "default" }, historyAction: "POP" },
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => undefined;
    },
    navigate: vi.fn(async () => undefined),
  };
  /** 模拟一次导航：更新路由状态并通知订阅者 */
  const emit = (path: string, historyAction: RouterStateLike["historyAction"] = "PUSH") => {
    seq += 1;
    router.state = { location: { pathname: path, key: `k${seq}` }, historyAction };
    for (const fn of subscribers) {
      fn(router.state);
    }
  };
  return { router, emit };
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

  it("顶栏与背景设成纸色（设计只有浅色）", async () => {
    const webApp = fakeWebApp();
    window.Telegram = { WebApp: webApp };
    await initTelegram(fakeRouter("/").router, { hash: "#tgWebAppData=abc", search: "" });
    expect(PAPER_COLOR).toBe("#F6F8FA");
    expect(webApp.setHeaderColor).toHaveBeenCalledWith(PAPER_COLOR);
    expect(webApp.setBackgroundColor).toHaveBeenCalledWith(PAPER_COLOR);
  });

  it("旧客户端没有或不支持设色方法时照常初始化", async () => {
    const webApp = fakeWebApp();
    delete webApp.setBackgroundColor;
    webApp.setHeaderColor = vi.fn(() => {
      throw new Error("WebAppMethodUnsupported");
    });
    window.Telegram = { WebApp: webApp };
    await expect(initTelegram(fakeRouter("/").router, { hash: "#tgWebAppData=abc", search: "" })).resolves.toBe(true);
    expect(webApp.BackButton.onClick).toHaveBeenCalled();
  });

  describe("返回按钮", () => {
    async function setup(pathname: string) {
      const webApp = fakeWebApp();
      window.Telegram = { WebApp: webApp };
      const fake = fakeRouter(pathname);
      await initTelegram(fake.router, { hash: "#tgWebAppData=abc", search: "" });
      const onBack = vi.mocked(webApp.BackButton.onClick).mock.calls[0]![0];
      return { ...fake, webApp, onBack };
    }

    it("直接打开内页（没有应用内历史）时回首页而不是后退", async () => {
      const { router, onBack } = await setup("/orders/WR7K2M9QXA");
      onBack();
      expect(router.navigate).toHaveBeenCalledWith("/", { replace: true });
      expect(router.navigate).not.toHaveBeenCalledWith(-1);
    });

    it("应用内前进后可后退；退回到第一页后再按回首页", async () => {
      const { router, emit, onBack } = await setup("/events");
      emit("/events/phnom-penh-half-2026");
      onBack();
      expect(router.navigate).toHaveBeenLastCalledWith(-1);

      emit("/events", "POP");
      onBack();
      expect(router.navigate).toHaveBeenLastCalledWith("/", { replace: true });
    });

    it("replace 导航不算一步历史", async () => {
      const { router, emit, onBack } = await setup("/");
      emit("/events/phnom-penh-half-2026", "REPLACE");
      onBack();
      expect(router.navigate).toHaveBeenLastCalledWith("/", { replace: true });
    });
  });
});

describe("start_param 深链", () => {
  it("event-<slug> 与 order-<orderNo> 映射到详情页，其他值忽略", () => {
    expect(startParamTarget("event-phnom-penh-half-2026")).toBe("/events/phnom-penh-half-2026");
    expect(startParamTarget("order-WR7K2M9QXA")).toBe("/orders/WR7K2M9QXA");
    expect(startParamTarget("ref-bkk-runners")).toBe("/r/bkk-runners");
    for (const bad of [null, undefined, "", "event-", "order-", "order-WR7K-2M", "promo-123", "event-../me", "event-a b", `event-${"x".repeat(80)}`, "ref-BKK", "ref-x", "ref-a_b"]) {
      expect(startParamTarget(bad)).toBeNull();
    }
  });

  it("Telegram 中优先读 initDataUnsafe.start_param，浏览器读 ?startapp=", () => {
    const webApp = { ...fakeWebApp(), initDataUnsafe: { start_param: "order-AAA111" } };
    expect(readStartParam({ hash: "#tgWebAppData=abc&tgWebAppStartParam=event-x", search: "" }, webApp)).toBe("order-AAA111");
    expect(readStartParam({ hash: "#tgWebAppData=abc&tgWebAppStartParam=event-x", search: "" }, fakeWebApp())).toBe("event-x");
    expect(readStartParam({ hash: "", search: "?startapp=event-phnom-penh-half-2026" })).toBe("event-phnom-penh-half-2026");
    expect(readStartParam({ hash: "", search: "" })).toBeNull();
  });

  it("Telegram 启动时按 start_param 用 replace 跳到订单详情", async () => {
    const webApp = { ...fakeWebApp(), initDataUnsafe: { start_param: "order-WR7K2M9QXA" } };
    window.Telegram = { WebApp: webApp };
    const { router } = fakeRouter("/");
    await initTelegram(router, { hash: "#tgWebAppData=abc", search: "" });
    expect(router.navigate).toHaveBeenCalledWith("/orders/WR7K2M9QXA", { replace: true });
  });

  it("浏览器模式支持 ?startapp=，且不加载 SDK", async () => {
    const { router } = fakeRouter("/");
    await expect(initTelegram(router, { hash: "", search: "?startapp=event-phnom-penh-half-2026" })).resolves.toBe(false);
    expect(router.navigate).toHaveBeenCalledWith("/events/phnom-penh-half-2026", { replace: true });
    expect(document.querySelector(`script[src="${TELEGRAM_SDK_URL}"]`)).toBeNull();
  });

  it("无效值或不在首页时不跳转", () => {
    const home = fakeRouter("/").router;
    expect(applyStartParam(home, "promo-1")).toBe(false);
    expect(home.navigate).not.toHaveBeenCalled();

    const inner = fakeRouter("/orders/WR1").router;
    expect(applyStartParam(inner, "event-phnom-penh-half-2026")).toBe(false);
    expect(inner.navigate).not.toHaveBeenCalled();
  });
});

describe("applyTelegramTheme", () => {
  it("把 themeParams 的下划线名转换为 CSS 变量", () => {
    const webApp = fakeWebApp();
    applyTelegramTheme(webApp);
    expect(document.documentElement.style.getPropertyValue("--tg-button-color")).toBe("#0f66ae");
  });
});

describe("loadTelegramSdk", () => {
  it("并发调用只插入一个 script，加载完成后都拿到 WebApp", async () => {
    const first = loadTelegramSdk();
    const second = loadTelegramSdk();

    const scripts = document.querySelectorAll(`script[src="${TELEGRAM_SDK_URL}"]`);
    expect(scripts).toHaveLength(1);

    const webApp = fakeWebApp();
    window.Telegram = { WebApp: webApp };
    scripts[0]!.dispatchEvent(new Event("load"));

    await expect(first).resolves.toBe(webApp);
    await expect(second).resolves.toBe(webApp);
  });

  it("脚本加载失败时拒绝", async () => {
    const pending = loadTelegramSdk();
    document.querySelector(`script[src="${TELEGRAM_SDK_URL}"]`)!.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow(TELEGRAM_SDK_URL);
  });
});

describe("与真实数据路由器配合", () => {
  it("深链 replace 后没有历史，返回按钮回首页；应用内前进后按返回才后退", async () => {
    const router = createMemoryRouter(
      [{ path: "/" }, { path: "/events" }, { path: "/events/:slug" }, { path: "/orders/:orderNo" }],
      { initialEntries: ["/"] },
    );
    const webApp = { ...fakeWebApp(), initDataUnsafe: { start_param: "event-phnom-penh-half-2026" } };
    window.Telegram = { WebApp: webApp };

    await initTelegram(router, { hash: "#tgWebAppData=abc", search: "" });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/events/phnom-penh-half-2026"));
    const onBack = vi.mocked(webApp.BackButton.onClick).mock.calls[0]![0];

    await router.navigate("/orders/WR1");
    onBack();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/events/phnom-penh-half-2026"));

    onBack();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    router.dispose();
  });
});
