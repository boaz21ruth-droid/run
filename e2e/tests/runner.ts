import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";
import { TELEGRAM_BOT_TOKEN, USER_URL } from "./env";

/** 浏览器模式：在登录页用固定验证码 123456 登录（compose 环境 WERUN_OTP_SENDER=fixed） */
export async function loginByPhone(page: Page, localNumber: string): Promise<void> {
  await page.getByTestId("login-phone").fill(localNumber);
  await page.getByTestId("login-send").click();
  await page.getByTestId("login-code").fill("123456");
  await page.getByTestId("login-verify").click();
}

/** 与 web/user/src/telegram/telegram.ts 的 TELEGRAM_SDK_URL 相同 */
export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

/** Telegram initData 里 user 字段的 JSON 形状 */
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * 按 Global Constraints 签名：
 * secret = HMAC_SHA256(key="WebAppData", msg=botToken)
 * hash = hex(HMAC_SHA256(key=secret, msg=data_check_string))
 * data_check_string = 除 hash 外的字段按键名排序，以 \n 连接的 key=value（值为原文，不做 URL 编码）
 * 返回 URL 编码后的查询串，含 auth_date、user（JSON）、hash。
 */
export function signInitData(botToken: string, user: TelegramUser, authDate: Date): string {
  const fields: [string, string][] = [
    ["auth_date", String(Math.floor(authDate.getTime() / 1000))],
    ["user", JSON.stringify(user)],
  ];
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

/** 每次调用生成一个新的 Telegram 用户，避免多次运行之间共享跑者数据 */
export function runnerUser(firstName: string, languageCode: "zh" | "en" | "km"): TelegramUser {
  const id = 7_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  return {
    id,
    first_name: firstName,
    last_name: "E2E",
    username: `e2e_${id}`,
    language_code: languageCode,
  };
}

function telegramStubScript(initData: string): string {
  const params = new URLSearchParams(initData);
  const initDataUnsafe = {
    user: JSON.parse(params.get("user") ?? "{}") as unknown,
    auth_date: Number(params.get("auth_date")),
    hash: params.get("hash"),
  };
  return `(() => {
  if (window.Telegram && window.Telegram.WebApp) {
    return;
  }
  const noop = () => {};
  window.Telegram = {
    WebApp: {
      initData: ${JSON.stringify(initData)},
      initDataUnsafe: ${JSON.stringify(initDataUnsafe)},
      ready: noop,
      expand: noop,
      themeParams: {},
      viewportStableHeight: 800,
      onEvent: noop,
      offEvent: noop,
      BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
    },
  };
})();`;
}

const pageRunners = new WeakMap<Page, number>();

/**
 * 以 Telegram 小程序身份打开用户端页面（实现调整 #5）：
 * 1. 拦截 TELEGRAM_SDK_URL，返回设置 window.Telegram.WebApp 的桩脚本；
 * 2. 同一段脚本也用 addInitScript 在页面脚本之前执行，避免登录逻辑早于 SDK 加载读取 initData；
 * 3. 打开 `${USER_URL}${path}#tgWebAppData=<initData>`。
 * 一个 page 只对应一个跑者；换跑者请新建 context。
 */
export async function openAsRunner(page: Page, user: TelegramUser, path: string): Promise<void> {
  const bound = pageRunners.get(page);
  if (bound !== undefined && bound !== user.id) {
    throw new Error(`page 已绑定跑者 ${bound}，不能再以 ${user.id} 打开；请为不同跑者新建 context`);
  }
  const initData = signInitData(TELEGRAM_BOT_TOKEN, user, new Date());
  if (bound === undefined) {
    const script = telegramStubScript(initData);
    await page.route(TELEGRAM_SDK_URL, (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: script }),
    );
    await page.addInitScript(script);
    pageRunners.set(page, user.id);
  }
  // 只差 hash 的地址不会重新加载文档，先离开当前页保证完整加载
  if (page.url().startsWith(USER_URL)) {
    await page.goto("about:blank");
  }
  await page.goto(`${USER_URL}${path}#tgWebAppData=${encodeURIComponent(initData)}`);
}
