import { describe, expect, it, vi } from "vitest";
import type { TelegramWebApp } from "../telegram/telegram";
import {
  DEV_INIT_DATA_KEY,
  TOKEN_EXPIRES_KEY,
  TOKEN_KEY,
  clearToken,
  readToken,
  resolveInitData,
  saveToken,
} from "./session";

const NOW = Date.parse("2026-09-14T03:00:00Z");

describe("令牌存储", () => {
  it("使用约定的 sessionStorage 键", () => {
    expect(TOKEN_KEY).toBe("werun.appToken");
    expect(TOKEN_EXPIRES_KEY).toBe("werun.appTokenExpiresAt");
    expect(DEV_INIT_DATA_KEY).toBe("werun.devInitData");
  });

  it("未过期时返回令牌", () => {
    saveToken("tok-1", "2026-09-15T03:00:00Z");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    expect(window.sessionStorage.getItem(TOKEN_EXPIRES_KEY)).toBe("2026-09-15T03:00:00Z");
    expect(readToken(NOW)).toBe("tok-1");
  });

  it("过期、即将在 30 秒内过期、时间无法解析或缺少时返回 null", () => {
    saveToken("tok-1", "2026-09-14T03:00:20Z");
    expect(readToken(NOW)).toBeNull();

    saveToken("tok-1", "not-a-date");
    expect(readToken(NOW)).toBeNull();

    window.sessionStorage.removeItem(TOKEN_EXPIRES_KEY);
    expect(readToken(NOW)).toBeNull();
  });

  it("clearToken 删除令牌与过期时间", () => {
    saveToken("tok-1", "2026-09-15T03:00:00Z");
    clearToken();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(TOKEN_EXPIRES_KEY)).toBeNull();
  });
});

describe("resolveInitData", () => {
  const plainBrowser = { hash: "", search: "" };

  it("优先使用 Telegram WebApp 的 initData", async () => {
    window.Telegram = { WebApp: { initData: "tg-init-data" } as TelegramWebApp };
    window.sessionStorage.setItem(DEV_INIT_DATA_KEY, "stored-dev");

    await expect(resolveInitData({ hash: "", search: "?devInitData=query-dev" })).resolves.toBe("tg-init-data");
  });

  it("地址带 tgWebAppData 时等待 SDK 加载后读取", async () => {
    const pending = resolveInitData({ hash: "#tgWebAppData=abc", search: "" });
    window.Telegram = { WebApp: { initData: "from-sdk" } as TelegramWebApp };
    document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')!.dispatchEvent(new Event("load"));

    await expect(pending).resolves.toBe("from-sdk");
  });

  it("开发构建读取 ?devInitData= 并存入 sessionStorage", async () => {
    const value = "user=%7B%22id%22%3A1%7D&auth_date=1&hash=ab";
    await expect(resolveInitData({ hash: "", search: `?devInitData=${encodeURIComponent(value)}` })).resolves.toBe(value);
    expect(window.sessionStorage.getItem(DEV_INIT_DATA_KEY)).toBe(value);
  });

  it("开发构建在地址没有参数时读取 werun.devInitData", async () => {
    window.sessionStorage.setItem(DEV_INIT_DATA_KEY, "stored-dev");
    await expect(resolveInitData(plainBrowser)).resolves.toBe("stored-dev");
  });

  it("生产构建忽略开发登录参数", async () => {
    vi.stubEnv("DEV", false);
    window.sessionStorage.setItem(DEV_INIT_DATA_KEY, "stored-dev");
    await expect(resolveInitData({ hash: "", search: "?devInitData=query-dev" })).resolves.toBeNull();
  });

  it("什么都没有时返回 null", async () => {
    await expect(resolveInitData(plainBrowser)).resolves.toBeNull();
  });
});
