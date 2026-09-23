import { isTelegram, loadTelegramSdk } from "../telegram/telegram";

export const TOKEN_KEY = "werun.appToken";
export const TOKEN_EXPIRES_KEY = "werun.appTokenExpiresAt";
export const DEV_INIT_DATA_KEY = "werun.devInitData";

/** 离过期不足这个时长的令牌当作已过期，避免请求途中失效 */
const EXPIRY_SKEW_MS = 30_000;

export type LocationLike = Pick<Location, "hash" | "search">;

type SessionMode = "telegram" | "browser";

/**
 * 是否处于 Telegram Mini App 只在首次用到存储时探测一次，然后锁定到整个会话期间。
 * Telegram WebApp SDK 加载后会把 tgWebAppData 从地址栏拿掉，如果每次都重新探测，
 * 令牌会突然从 sessionStorage 读不到（转去找 localStorage），browserMode() 也会跟着
 * 误判成浏览器模式，401 时把 Telegram 跑者错误登出。
 */
let mode: SessionMode | null = null;

function resolveMode(): SessionMode {
  if (mode === null) {
    mode = isTelegram() ? "telegram" : "browser";
  }
  return mode;
}

/** 仅供测试重置缓存的登录模式；生产代码不会调用。测试里改了 window.location.hash 后、下一次存储调用前必须先调它。 */
export function resetSessionModeForTests(): void {
  mode = null;
}

/** 浏览器模式（非 Telegram Mini App）：跑者可以直接用手机号登录 */
export function isBrowserMode(): boolean {
  return resolveMode() === "browser";
}

function storage(): Storage | null {
  try {
    // Telegram Mini App 关掉就丢登录态，用 sessionStorage；普通浏览器需要跨会话保留，用 localStorage
    return resolveMode() === "telegram" ? window.sessionStorage : window.localStorage;
  } catch {
    // 隐私模式等场景禁用存储时，令牌只保存在内存之外，每次都用 initData 重新登录
    return null;
  }
}

export function readToken(now: number = Date.now()): string | null {
  const store = storage();
  const token = store?.getItem(TOKEN_KEY);
  const expiresAt = store?.getItem(TOKEN_EXPIRES_KEY);
  if (!token || !expiresAt) {
    return null;
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= now + EXPIRY_SKEW_MS) {
    return null;
  }
  return token;
}

export function saveToken(token: string, expiresAt: string): void {
  const store = storage();
  store?.setItem(TOKEN_KEY, token);
  store?.setItem(TOKEN_EXPIRES_KEY, expiresAt);
}

export function clearToken(): void {
  const store = storage();
  store?.removeItem(TOKEN_KEY);
  store?.removeItem(TOKEN_EXPIRES_KEY);
}

async function telegramInitData(location: LocationLike): Promise<string> {
  const loaded = window.Telegram?.WebApp?.initData;
  if (loaded) {
    return loaded;
  }
  if (!isTelegram(location)) {
    return "";
  }
  try {
    return (await loadTelegramSdk()).initData ?? "";
  } catch {
    return "";
  }
}

/**
 * initData 来源顺序：Telegram WebApp → 开发构建的 ?devInitData=（读到后存入 storage()，浏览器模式下是 localStorage）→ 开发构建存下的 werun.devInitData。
 * 开发登录参数整段放在 import.meta.env.DEV 分支里，生产构建不包含。
 */
export async function resolveInitData(location: LocationLike = window.location): Promise<string | null> {
  const fromTelegram = await telegramInitData(location);
  if (fromTelegram) {
    return fromTelegram;
  }
  if (import.meta.env.DEV) {
    const fromQuery = new URLSearchParams(location.search).get("devInitData");
    if (fromQuery) {
      storage()?.setItem(DEV_INIT_DATA_KEY, fromQuery);
      return fromQuery;
    }
    const stored = storage()?.getItem(DEV_INIT_DATA_KEY);
    if (stored) {
      return stored;
    }
  }
  return null;
}
