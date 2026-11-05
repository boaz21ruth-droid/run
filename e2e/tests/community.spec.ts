import { expect, test, type Browser } from "@playwright/test";
import { ADMIN_URL, OPS } from "./env";
import { adminFetch, adminSession, presetLanguage } from "./helpers";
import { openAsRunner, runnerUser, type TelegramUser } from "./runner";

// 跑团页：跑者发布活动 → 运营审核通过 → 别的跑者在跑团页看到、参加并看到联系方式；满员后进候补。
const runId = Date.now().toString(36);
const title = `夜跑 ${runId}`;
const hostTelegram = `host_${runId}`;
const host = runnerUser("Rithy", "zh");
const dara = runnerUser("Dara", "zh");
const sophea = runnerUser("Sophea", "zh");
const shared = { activityId: 0 };

test.describe.configure({ mode: "serial" });

async function runnerPage(browser: Browser, user: TelegramUser, path: string) {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await openAsRunner(page, user, path);
  return { context, page };
}

/** 明天 19:00（浏览器本地时间），datetime-local 的格式 */
function tomorrowEvening(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T19:00`;
}

test("跑者发布跑团活动（1 个名额），提交后显示审核中", async ({ browser }) => {
  const { context, page } = await runnerPage(browser, host, "/community");
  await page.getByTestId("community-publish").click();
  await expect(page).toHaveURL(/\/community\/new$/);
  await page.getByTestId("community-title").fill(title);
  await page.locator("label").filter({ hasText: /^夜跑$/ }).click();
  await expect(page.getByRole("radio", { name: "夜跑" })).toBeChecked();
  await page.getByTestId("community-startsAt").fill(tomorrowEvening());
  await page.getByTestId("community-location").fill("滨河大道");
  await page.getByTestId("community-meetPoint").fill("独立纪念碑北侧");
  await page.getByTestId("community-capacity").fill("1");
  await page.getByTestId("community-hostName").fill("BKK Runners");
  await page.getByTestId("community-contactTelegram").fill(`@${hostTelegram}`);
  await page.getByTestId("community-body").fill("配速 6:00，结束后喝椰子水。");
  await page.getByTestId("community-consent-safety").check();
  await page.getByTestId("community-submit").click();

  await expect(page).toHaveURL(/\/community\/\d+$/);
  shared.activityId = Number(/\/community\/(\d+)$/.exec(new URL(page.url()).pathname)![1]);
  await expect(page.getByTestId("community-author-status")).toHaveAttribute("data-status", "REVIEWING");
  await context.close();
});

test("运营在后台审核通过", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await page.goto(`${ADMIN_URL}/community`);
  await page.getByTestId(`community-approve-${shared.activityId}`).click();
  await expect(page.getByTestId(`community-approve-${shared.activityId}`)).toHaveCount(0);
  const list = await adminFetch<{ items: { activity: { id: number } }[] }>(
    page,
    "GET",
    "/admin/community/activities?status=PUBLISHED",
  );
  expect(list.json.items.some((r) => r.activity.id === shared.activityId)).toBe(true);
  await context.close();
});

test("跑者在跑团页看到活动并参加，看到发起人联系方式；第二个人进候补，前一个退出后自动补上", async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await runnerPage(browser, dara, "/community");
  await a.page.getByTestId("community-filter-CLUB").click();
  const card = a.page.getByTestId(`community-club-${shared.activityId}`);
  await expect(card).toContainText(title);
  await expect(card).toContainText("BKK Runners");
  await a.page.getByTestId(`community-open-${shared.activityId}`).click();
  await a.page.getByTestId("community-join").click();
  await expect(a.page.getByTestId("community-contact")).toContainText(`@${hostTelegram}`);

  const b = await runnerPage(browser, sophea, `/community/${shared.activityId}`);
  await expect(b.page.getByTestId("community-join")).toContainText("已满，排候补");
  await b.page.getByTestId("community-join").click();
  await expect(b.page.getByTestId("community-my-status")).toHaveAttribute("data-status", "WAITLIST");
  await expect(b.page.getByTestId("community-contact")).toHaveCount(0);

  await a.page.getByTestId("community-leave").click();
  await expect(a.page.getByTestId("community-join")).toBeVisible();
  await b.page.reload();
  await expect(b.page.getByTestId("community-my-status")).toHaveAttribute("data-status", "JOINED");
  await expect(b.page.getByTestId("community-contact")).toContainText(`@${hostTelegram}`);

  await a.context.close();
  await b.context.close();
});

test("跑者签到「今天我在跑」，出现在跑团页", async ({ browser }) => {
  const { context, page } = await runnerPage(browser, dara, "/community");
  const button = page.getByTestId("community-checkin");
  if ((await button.getAttribute("aria-pressed")) === "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Dara", { exact: true })).toBeVisible();
  await context.close();
});
