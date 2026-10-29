/**
 * Telegram Mini App 适配。只在 URL 带 tgWebAppData 时加载官方 SDK，普通浏览器不下载任何脚本。
 * initData 的服务端校验与跑者登录一起做，不在这里。
 */
export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

export interface TelegramWebApp {
  /** 原样传给 POST /api/app/auth/telegram 的签名查询串；不在 Telegram 中打开时为空串 */
  initData: string;
  ready(): void;
  expand(): void;
  themeParams: Record<string, string | undefined>;
  viewportStableHeight: number;
  onEvent(event: "themeChanged" | "viewportChanged", handler: () => void): void;
  /** 只取用到的字段；start_param 来自 t.me/<bot>/<app>?startapp=<值> 链接 */
  initDataUnsafe?: { start_param?: string };
  /** Bot API 6.1+；旧客户端可能没有或不支持十六进制色值 */
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  /** 在 Telegram 内打开 t.me 链接（如分享面板），不跳出小程序 */
  openTelegramLink?(url: string): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export interface RouterStateLike {
  location: { pathname: string; key: string };
  historyAction: "POP" | "PUSH" | "REPLACE";
}

/** react-router 数据路由器中本适配层用到的部分 */
export interface RouterLike {
  state: RouterStateLike;
  subscribe(fn: (state: RouterStateLike) => void): () => void;
  navigate(delta: number): Promise<void> | void;
  navigate(to: string, options?: { replace?: boolean }): Promise<void> | void;
}

/** 设计只有浅色：Telegram 顶栏与背景统一用纸色（tokens.css 的 --paper） */
export const PAPER_COLOR = "#F6F8FA";

type LocationLike = Pick<Location, "hash" | "search">;

export function isTelegram(location: LocationLike = window.location): boolean {
  return location.hash.includes("tgWebAppData") || location.search.includes("tgWebAppData");
}

export function loadTelegramSdk(): Promise<TelegramWebApp> {
  if (window.Telegram?.WebApp) {
    return Promise.resolve(window.Telegram.WebApp);
  }
  return new Promise((resolve, reject) => {
    // 主题适配与登录会同时等待 SDK：复用已插入的 script，只下载一次
    let script = document.querySelector<HTMLScriptElement>(`script[src="${TELEGRAM_SDK_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = TELEGRAM_SDK_URL;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => {
      if (window.Telegram?.WebApp) {
        resolve(window.Telegram.WebApp);
      } else {
        reject(new Error("Telegram SDK 已加载，但 window.Telegram.WebApp 不存在"));
      }
    });
    script.addEventListener("error", () => reject(new Error(`无法加载 ${TELEGRAM_SDK_URL}`)));
  });
}

export function applyTelegramTheme(webApp: TelegramWebApp, root: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(webApp.themeParams)) {
    if (value) {
      root.style.setProperty(`--tg-${key.replaceAll("_", "-")}`, value);
    }
  }
  root.style.setProperty("--tg-viewport-height", `${webApp.viewportStableHeight}px`);
}

/** start_param 只允许 Telegram 规定的字符集与长度 */
const START_PARAM = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_PARAM = /^event-([A-Za-z0-9][A-Za-z0-9_-]*)$/;
const ORDER_PARAM = /^order-([A-Za-z0-9]+)$/;

/** 把 start_param 换成应用内路径：event-<slug> → 赛事详情，order-<orderNo> → 订单详情；其他值返回 null */
export function startParamTarget(param: string | null | undefined): string | null {
  if (!param || !START_PARAM.test(param)) {
    return null;
  }
  const event = EVENT_PARAM.exec(param);
  if (event) {
    return `/events/${encodeURIComponent(event[1]!)}`;
  }
  const order = ORDER_PARAM.exec(param);
  if (order) {
    return `/orders/${encodeURIComponent(order[1]!)}`;
  }
  return null;
}

/**
 * 启动参数：Telegram 中优先取 initDataUnsafe.start_param，其次是地址里的 tgWebAppStartParam；
 * 普通浏览器取 ?startapp=，与 t.me 链接的写法一致，便于本地调试和分享网页链接。
 */
export function readStartParam(location: LocationLike = window.location, webApp?: TelegramWebApp): string | null {
  const fromSdk = webApp?.initDataUnsafe?.start_param;
  if (fromSdk) {
    return fromSdk;
  }
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  return search.get("tgWebAppStartParam") ?? hash.get("tgWebAppStartParam") ?? search.get("startapp");
}

/**
 * 启动时按 start_param 跳转一次（replace，不留下首页这条历史）。只在落在首页时生效：
 * 跳转后刷新页面停在目标页，不会被同一个 start_param 再次拉回。
 */
export function applyStartParam(router: RouterLike, param: string | null | undefined): boolean {
  const target = startParamTarget(param);
  if (!target || router.state.location.pathname !== "/") {
    return false;
  }
  void router.navigate(target, { replace: true });
  return true;
}

/** 记录应用内还能后退几步：PUSH +1，POP −1，REPLACE 不变。刷新后从浏览器历史里的 idx 接着算。 */
export function trackHistoryDepth(router: RouterLike): () => number {
  const idx: unknown = (window.history.state as { idx?: unknown } | null)?.idx;
  let depth = typeof idx === "number" && idx > 0 ? idx : 0;
  let lastKey = router.state.location.key;
  router.subscribe((state) => {
    if (state.location.key === lastKey) {
      return;
    }
    lastKey = state.location.key;
    if (state.historyAction === "PUSH") {
      depth += 1;
    } else if (state.historyAction === "POP") {
      depth = Math.max(0, depth - 1);
    }
  });
  return () => depth;
}

function applyPaperColors(webApp: TelegramWebApp): void {
  // 旧版客户端调用不支持的方法会抛错，颜色只是锦上添花，失败就算了
  try {
    webApp.setHeaderColor?.(PAPER_COLOR);
    webApp.setBackgroundColor?.(PAPER_COLOR);
  } catch {
    // 忽略
  }
}

export async function initTelegram(router: RouterLike, location: LocationLike = window.location): Promise<boolean> {
  if (!isTelegram(location)) {
    applyStartParam(router, readStartParam(location));
    return false;
  }
  const webApp = await loadTelegramSdk();
  webApp.ready();
  webApp.expand();
  applyPaperColors(webApp);

  applyTelegramTheme(webApp);
  webApp.onEvent("themeChanged", () => applyTelegramTheme(webApp));
  webApp.onEvent("viewportChanged", () => applyTelegramTheme(webApp));

  const historyDepth = trackHistoryDepth(router);
  const syncBackButton = (pathname: string) => {
    if (pathname === "/") {
      webApp.BackButton.hide();
    } else {
      webApp.BackButton.show();
    }
  };
  syncBackButton(router.state.location.pathname);
  router.subscribe((state) => syncBackButton(state.location.pathname));
  webApp.BackButton.onClick(() => {
    // 从深链或分享链接直接打开时没有应用内历史，navigate(-1) 会退出小程序或无反应：回首页
    if (historyDepth() > 0) {
      void router.navigate(-1);
    } else {
      void router.navigate("/", { replace: true });
    }
  });

  applyStartParam(router, readStartParam(location, webApp));
  return true;
}
