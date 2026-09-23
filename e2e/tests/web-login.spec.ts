import { expect, test } from "@playwright/test";
import { OPS, USER_URL } from "./env";
import { adminSession, createAndPublishEvent, openEventDetail, openRegistration, presetLanguage } from "./helpers";
import { loginByPhone } from "./runner";

const runId = Date.now().toString(36);
const slug = `e2e-web-${runId}`;
// 每次运行用不同号码，避免上一轮的 60 秒冷却
const localNumber = `9${String(Date.now()).slice(-7)}`;

test.describe.configure({ mode: "serial" });

test("后台建免费活动并开放报名", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await createAndPublishEvent(page, {
    slug,
    name: { zh: `网页登录测试 ${runId}`, en: `Web login ${runId}`, km: `Web ${runId}` },
    eventType: "FREE_ACTIVITY",
    capacity: 10,
  });
  const { id } = await openEventDetail(page, slug);
  await openRegistration(page, id);
  await context.close();
});

test("浏览器打开报名页被送到登录页，手机号登录后回到报名页", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await page.goto(`${USER_URL}/events/${slug}/free-signup`);
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fevents%2F${slug}%2Ffree-signup$`));

  await loginByPhone(page, localNumber);

  await expect(page).toHaveURL(`${USER_URL}/events/${slug}/free-signup`);
  await expect(page.getByTestId("nav-me")).toContainText("+855");

  // 令牌在 localStorage：新标签页仍是登录态
  const other = await context.newPage();
  await other.goto(`${USER_URL}/orders`);
  await expect(other).toHaveURL(`${USER_URL}/orders`);
  await context.close();
});

test("验证码错误提示剩余次数", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await page.goto(`${USER_URL}/login`);
  await page.getByTestId("login-phone").fill(`8${String(Date.now()).slice(-7)}`);
  await page.getByTestId("login-send").click();
  await page.getByTestId("login-code").fill("000000");
  await page.getByTestId("login-verify").click();
  await expect(page.getByRole("alert")).toContainText("验证码不正确");
  await context.close();
});
