import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_URL, OPS, USER_URL } from "./env";
import { fillDate, loginAdmin, presetLanguage, RACE_DATE, raceDateTime } from "./helpers";

const runId = Date.now().toString(36);
const slug = `e2e-${runId}`;
const name = {
  zh: `端到端测试赛 ${runId}`,
  en: `E2E Test Run ${runId}`,
  km: `ការរត់សាកល្បង ${runId}`,
};

test.describe.configure({ mode: "serial" });

test("OPS 新建并发布赛事", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await loginAdmin(page, OPS.username, OPS.password);

  await page.getByTestId("event-create-button").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events/new`);

  await page.locator("#event_slug").fill(slug);
  await page.locator("#event_name_zh").fill(name.zh);
  await page.locator("#event_name_en").fill(name.en);
  await page.locator("#event_name_km").fill(name.km);
  await page.locator("#event_city").fill("Phnom Penh");
  await fillDate(page, "#event_raceDate", RACE_DATE);

  // 表单默认已带一个空组别
  await page.locator("#event_categories_0_code").fill("10K");
  await page.locator("#event_categories_0_name_zh").fill("欢乐 10K");
  await page.locator("#event_categories_0_name_en").fill("Fun 10K");
  await page.locator("#event_categories_0_name_km").fill("រត់ 10K");
  await page.locator("#event_categories_0_distanceM").fill("10000");
  await page.locator("#event_categories_0_capacity").fill("500");
  await fillDate(page, "#event_categories_0_startAt", raceDateTime("06:00"));
  await fillDate(page, "#event_categories_0_cutoffAt", raceDateTime("09:00"));

  await page.getByTestId("event-form-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);

  const publish = page.getByTestId(`event-publish-${slug}`);
  await expect(publish).toBeVisible();
  await publish.click();
  await expect(publish).toBeHidden();

  await context.close();
});

test("用户端能看到赛事，切换高棉文后显示高棉文名称", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "en");
  const page = await context.newPage();

  await page.goto(`${USER_URL}/events`);
  await expect(page.getByTestId("event-card").filter({ hasText: name.en })).toBeVisible();

  await page.getByTestId("lang-switch-km").click();
  await expect(page.getByTestId("event-card").filter({ hasText: name.km })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "km");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "km");
  await expect(page.getByTestId("event-card").filter({ hasText: name.km })).toBeVisible();

  await context.close();
});

test("ADMIN 只读：能看列表，没有新建按钮，直接调用新建接口返回 403", async ({ browser }) => {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();

  await loginAdmin(page, ADMIN.username, ADMIN.password);

  await expect(page.getByText(name.zh)).toBeVisible();
  await expect(page.getByTestId("event-create-button")).toHaveCount(0);
  await expect(page.getByTestId(`event-publish-${slug}`)).toHaveCount(0);

  const result = await page.evaluate(async (body) => {
    const res = await fetch("/api/admin/events", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "zh",
        "X-WeRun-Client": "admin",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }, {
    slug: `${slug}-forbidden`,
    eventType: "RACE",
    organizerType: "OFFICIAL",
    name: { zh: "不应创建", en: "Should not be created", km: "មិនគួរបង្កើត" },
    city: "Phnom Penh",
    raceDate: RACE_DATE,
    categories: [],
  });

  expect(result.status).toBe(403);
  expect(result.json.error.code).toBe("FORBIDDEN");
  expect(result.json.error.message).toMatch(/[一-鿿]/);

  await context.close();
});
