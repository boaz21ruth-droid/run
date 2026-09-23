import { isTelegram, loadTelegramSdk } from "../telegram/telegram";

export const TOKEN_KEY = "werun.appToken";
export const TOKEN_EXPIRES_KEY = "werun.appTokenExpiresAt";
export const DEV_INIT_DATA_KEY = "werun.devInitData";

/** 离过期不足这个时长的令牌当作已过期，避免请求途中失效 */
const EXPIRY_SKEW_MS = 30_000;

export type LocationLike = Pick<Location, "hash" | "search">;

/** 浏览器模式（非 Telegram Mini App）：跑者可以直接用手机号登录 */
export function isBrowserMode(location: LocationLike = window.location): boolean {
  return !isTelegram(location);
}

function storage(): Storage | null {
  try {
    // Telegram Mini App 关掉就丢登录态，用 sessionStorage；普通浏览器需要跨会话保留，用 localStorage
    return isTelegram() ? window.sessionStorage : window.localStorage;
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
 * initData 来源顺序：Telegram WebApp → 开发构建的 ?devInitData=（读到后存入 sessionStorage）→ 开发构建存下的 werun.devInitData。
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
