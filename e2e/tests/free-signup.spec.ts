import { expect, test, type Page } from "@playwright/test";
import { OPS } from "./env";
import { adminSession, createAndPublishEvent, openEventDetail, openRegistration, presetLanguage } from "./helpers";
import { openAsRunner, runnerUser } from "./runner";

const runId = Date.now().toString(36);
const slug = `e2e-free-${runId}`;
const eventName = {
  zh: `免费活动测试 ${runId}`,
  en: `Free Activity E2E ${runId}`,
  km: `សកម្មភាពឥតគិតថ្លៃសាកល្បង ${runId}`,
};
const phone = `+85516${String(Date.now()).slice(-6)}`;
const CONSENT_KEYS = ["rules", "health", "terms"] as const;
const runner = runnerUser("Chenda", "zh");
const shared = { categoryId: 0 };

test.describe.configure({ mode: "serial" });

async function fillFreeSignup(page: Page, fullName: string): Promise<void> {
  await page.getByTestId("free-category").selectOption(String(shared.categoryId));
  await page.getByTestId("free-fullName").fill(fullName);
  await page.getByTestId("free-phone").fill(phone);
  await page.getByTestId("free-emergencyName").fill("Kim Sokha");
  await page.getByTestId("free-emergencyPhone").fill("+85598765432");
  await page.getByTestId("free-gender").selectOption("F");
  for (const key of CONSENT_KEYS) {
    await page.getByTestId(`consent-item-${key}`).check();
  }
}

test("OPS 建免费活动、发布并开放报名", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);

  await createAndPublishEvent(page, { slug, name: eventName, eventType: "FREE_ACTIVITY", capacity: 50 });
  const detail = await openEventDetail(page, slug);
  shared.categoryId = detail.categoryId;
  await openRegistration(page, detail.id);

  await context.close();
});

test("跑者免费报名成功；同名（大小写不同）同手机号再次报名提示已报名", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await openAsRunner(page, runner, `/events/${slug}`);
  await page.getByTestId("free-signup-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/free-signup$`));

  await fillFreeSignup(page, "Chenda Kim");
  await page.getByTestId("free-submit").click();
  await expect(page.getByTestId("free-signup-done")).toContainText(/FS[0-9A-Z]{8}/);

  await openAsRunner(page, runner, `/events/${slug}/free-signup`);
  await fillFreeSignup(page, "CHENDA KIM");
  await page.getByTestId("free-submit").click();

  const formError = page.getByTestId("form-error");
  await expect(formError).toHaveAttribute("data-code", "ALREADY_REGISTERED");
  await expect(formError).toHaveText("该姓名和手机号已报名这个组别");
  await expect(page.getByTestId("free-signup-done")).toHaveCount(0);

  await context.close();
});
