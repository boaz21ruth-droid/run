/**
 * Telegram Mini App 适配。只在 URL 带 tgWebAppData 时加载官方 SDK，普通浏览器不下载任何脚本。
 * initData 的服务端校验与跑者登录一起做，不在这里。
 */
export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

export interface TelegramWebApp {
  ready(): void;
  expand(): void;
  themeParams: Record<string, string | undefined>;
  viewportStableHeight: number;
  onEvent(event: "themeChanged" | "viewportChanged", handler: () => void): void;
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

/** react-router 数据路由器中本适配层用到的部分 */
export interface RouterLike {
  state: { location: { pathname: string } };
  subscribe(fn: (state: { location: { pathname: string } }) => void): () => void;
  navigate(delta: number): Promise<void> | void;
}

type LocationLike = Pick<Location, "hash" | "search">;

export function isTelegram(location: LocationLike = window.location): boolean {
  return location.hash.includes("tgWebAppData") || location.search.includes("tgWebAppData");
}

export function loadTelegramSdk(): Promise<TelegramWebApp> {
  if (window.Telegram?.WebApp) {
    return Promise.resolve(window.Telegram.WebApp);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TELEGRAM_SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.Telegram?.WebApp) {
        resolve(window.Telegram.WebApp);
      } else {
        reject(new Error("Telegram SDK 已加载，但 window.Telegram.WebApp 不存在"));
      }
    };
    script.onerror = () => reject(new Error(`无法加载 ${TELEGRAM_SDK_URL}`));
    document.head.appendChild(script);
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

export async function initTelegram(router: RouterLike, location: LocationLike = window.location): Promise<boolean> {
  if (!isTelegram(location)) {
    return false;
  }
  const webApp = await loadTelegramSdk();
  webApp.ready();
  webApp.expand();

  applyTelegramTheme(webApp);
  webApp.onEvent("themeChanged", () => applyTelegramTheme(webApp));
  webApp.onEvent("viewportChanged", () => applyTelegramTheme(webApp));

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
    void router.navigate(-1);
  });
  return true;
}
