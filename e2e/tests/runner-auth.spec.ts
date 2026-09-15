import { expect, test, type Page } from "@playwright/test";
import { TELEGRAM_BOT_TOKEN, USER_URL } from "./env";
import { openAsRunner, runnerUser, signInitData } from "./runner";

async function login(page: Page, initData: string) {
  return page.evaluate(
    async (body) => {
      const res = await fetch("/api/app/auth/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept-Language": "en" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    { initData },
  );
}

test("测试代码签名的 initData 通过真实接口登录", async ({ page }) => {
  await page.goto(`${USER_URL}/events`);
  const initData = signInitData(TELEGRAM_BOT_TOKEN, runnerUser("Dara", "en"), new Date());

  const result = await login(page, initData);

  expect(result.status).toBe(200);
  expect(typeof result.json.token).toBe("string");
  expect(String(result.json.token).length).toBeGreaterThan(20);
  expect(typeof result.json.expiresAt).toBe("string");
});

test("篡改 hash 的 initData 返回 TELEGRAM_AUTH_INVALID", async ({ page }) => {
  await page.goto(`${USER_URL}/events`);
  const initData = signInitData(TELEGRAM_BOT_TOKEN, runnerUser("Dara", "en"), new Date());
  const tampered = initData.replace(/hash=[0-9a-f]{64}/, `hash=${"0".repeat(64)}`);
  expect(tampered).not.toBe(initData);

  const result = await login(page, tampered);

  expect(result.status).toBe(401);
  expect((result.json.error as { code: string }).code).toBe("TELEGRAM_AUTH_INVALID");
});

test("openAsRunner 打开需要登录的页面时自动登录，不显示 open-in-telegram", async ({ page }) => {
  const loggedIn = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/app/auth/telegram" && res.status() === 200,
  );

  await openAsRunner(page, runnerUser("Sophea", "km"), "/orders");

  await loggedIn;
  await expect(page.getByTestId("orders-empty")).toBeVisible();
  await expect(page.getByTestId("open-in-telegram")).toHaveCount(0);
});
