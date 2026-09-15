import { expect, test, type Browser, type Page } from "@playwright/test";
import { ADMIN_URL, FINANCE, OPS } from "./env";
import {
  adminSession,
  centsToPlainUsd,
  createAndPublishEvent,
  fillControl,
  fillDate,
  makePng,
  openEventDetail,
  openRegistration,
  parseUsdCents,
  pickerNow,
  presetLanguage,
  selectAntdOption,
} from "./helpers";
import { openAsRunner, runnerUser, type TelegramUser } from "./runner";

// 价格档：早鸟 $20（配额 1，排序 0）+ 标准 $30（不限，排序 1）。两人同单时第 1 人取早鸟、第 2 人取标准，
// 原价合计 $50；10% 优惠码减 $5，算价应付 $45.00；下单再减识别分 1–50 分（契约补充 8）。
// 每次运行用新的 slug、优惠码、交易号与 Telegram 用户；serial 模式下重试会从第一条重新开始。
const runId = Date.now().toString(36);
const RUN = runId.toUpperCase();
const slug = `e2e-reg-${runId}`;
const eventName = {
  zh: `报名测试赛 ${runId}`,
  en: `Registration E2E ${runId}`,
  km: `ការប្រកួតសាកល្បងចុះឈ្មោះ ${runId}`,
};
const percentCode = `PCT${RUN}`;
const waiverCode = `FREE${RUN}`;
const accountName = `E2E ABA ${runId}`;
const rejectReason = `截图看不清 ${runId}`;
// PNG 颜色种子取自 runId（毫秒时间戳）：不同运行的文件 sha256 不同，重跑不会触发重复截图标记；
// 同一次运行内按序号偏移（低 24 位互不相同），二维码与两张凭证彼此不同。
const seedBase = Number.parseInt(runId, 36);
const pngSeed = (n: number) => (seedBase + n) & 0xffffff;
const CONSENT_KEYS = ["rules", "health", "terms"] as const;

const runnerA = runnerUser("Dara", "zh");
const runnerB = runnerUser("Sophea", "zh");

const shared = { eventId: 0, categoryId: 0, orderNo: "", dueCents: 0 };

test.describe.configure({ mode: "serial" });

async function runnerPage(browser: Browser, user: TelegramUser, path: string) {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await openAsRunner(page, user, path);
  return { context, page };
}

async function createPriceRule(
  page: Page,
  rule: { zh: string; en: string; km: string; priceUsd: string; quota: string; sortOrder: string },
): Promise<void> {
  await page.getByTestId("price-rule-create").click();
  await page.locator("#priceRule_name_zh").fill(rule.zh);
  await page.locator("#priceRule_name_en").fill(rule.en);
  await page.locator("#priceRule_name_km").fill(rule.km);
  await selectAntdOption(page, "priceRule_audience", "ALL");
  await page.locator("#priceRule_priceUsd").fill(rule.priceUsd);
  await page.locator("#priceRule_quota").fill(rule.quota);
  await page.locator("#priceRule_sortOrder").fill(rule.sortOrder);
  await selectAntdOption(page, "priceRule_categoryIds", String(shared.categoryId), { multiple: true });
  await page.getByTestId("price-rule-submit").click();
  await expect(page.locator("#priceRule_name_zh")).toHaveCount(0);
}

async function createCoupon(
  page: Page,
  coupon: { code: string; discountType: "PERCENT" | "WAIVER"; discountValue: string; quota: string },
): Promise<void> {
  await page.getByTestId("coupon-create").click();
  await page.locator("#coupon_code").fill(coupon.code);
  await selectAntdOption(page, "coupon_discountType", coupon.discountType);
  const value = page.locator("#coupon_discountValue");
  // 免单码的折扣值输入框是禁用的
  if (coupon.discountType !== "WAIVER") {
    await value.fill(coupon.discountValue);
  } else {
    await expect(value).toBeDisabled();
  }
  await page.locator("#coupon_quota").fill(coupon.quota);
  await page.getByTestId("coupon-submit").click();
  await expect(page.getByTestId(`coupon-row-${coupon.code}`)).toBeVisible();
}

async function ensureParticipants(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("participant-add")).toBeVisible();
  for (let i = 0; i < count; i += 1) {
    const category = page.getByTestId(`participant-${i}-category`);
    if ((await category.count()) === 0) {
      await page.getByTestId("participant-add").click();
    }
    await expect(category).toBeVisible();
  }
  await expect(page.getByTestId(`participant-${count}-category`)).toHaveCount(0);
}

async function fillParticipant(
  page: Page,
  index: number,
  p: { fullName: string; gender: string; birthDate: string; idNo: string; phone: string },
): Promise<void> {
  const field = (name: string) => page.getByTestId(`participant-${index}-${name}`);
  await field("fullName").fill(p.fullName);
  await fillControl(field("gender"), p.gender);
  await field("birthDate").fill(p.birthDate);
  await fillControl(field("nationality"), "KH");
  await fillControl(field("idType"), "PASSPORT");
  await field("idNo").fill(p.idNo);
  await field("phone").fill(p.phone);
  await field("emergencyName").fill("Sok Chan");
  await field("emergencyPhone").fill("+85598765432");
  await fillControl(field("tshirtSize"), "M");
}

async function checkConsents(page: Page): Promise<void> {
  for (const key of CONSENT_KEYS) {
    await page.getByTestId(`consent-item-${key}`).check();
  }
}

async function uploadProof(page: Page, txnRef: string, png: Buffer): Promise<void> {
  await page
    .getByTestId("proof-file-input")
    .setInputFiles({ name: `proof-${txnRef}.png`, mimeType: "image/png", buffer: png });
  await page.getByTestId("proof-txn-ref").fill(txnRef);
  await page.getByTestId("proof-amount").fill(centsToPlainUsd(shared.dueCents));
  await page.getByTestId("proof-submit").click();
  await expect(page).toHaveURL(new RegExp(`/orders/${shared.orderNo}$`));
  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PROOF_SUBMITTED");
}

async function openSubmittedProof(page: Page, orderNo: string): Promise<void> {
  await page.goto(`${ADMIN_URL}/proofs`);
  const row = page.locator('[data-testid^="proof-row-"]').filter({ hasText: orderNo });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page).toHaveURL(/\/proofs\/\d+$/);
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-status", "SUBMITTED");
  await expect(page.getByTestId("proof-image")).toBeVisible();
}

test("OPS 建赛事，配置早鸟与标准价格档、百分比与免单优惠码", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);

  await createAndPublishEvent(page, { slug, name: eventName, eventType: "RACE", capacity: 100 });
  const detail = await openEventDetail(page, slug);
  shared.eventId = detail.id;
  shared.categoryId = detail.categoryId;

  await page.getByTestId("event-tab-pricing").click();
  const rows = page.locator('[data-testid^="price-rule-row-"]');
  await createPriceRule(page, { zh: "早鸟价", en: "Early bird", km: "តម្លៃទិញមុន", priceUsd: "20", quota: "1", sortOrder: "0" });
  await expect(rows).toHaveCount(1);
  await createPriceRule(page, { zh: "标准价", en: "Standard", km: "តម្លៃស្តង់ដារ", priceUsd: "30", quota: "", sortOrder: "1" });
  await expect(rows).toHaveCount(2);

  await page.getByTestId("event-tab-coupons").click();
  await createCoupon(page, { code: percentCode, discountType: "PERCENT", discountValue: "10", quota: "10" });
  await createCoupon(page, { code: waiverCode, discountType: "WAIVER", discountValue: "0", quota: "5" });

  await context.close();
});

test("FINANCE 为该赛事建收款账户并上传二维码", async ({ browser }) => {
  const { context, page } = await adminSession(browser, FINANCE.username, FINANCE.password);

  await page.goto(`${ADMIN_URL}/payment-accounts`);
  await page.getByTestId("payment-account-create").click();
  await page.locator("#paymentAccount_name").fill(accountName);
  await selectAntdOption(page, "paymentAccount_provider", "ABA");
  await page.locator("#paymentAccount_accountName").fill("WERUN E2E");
  await page.locator("#paymentAccount_accountNoMasked").fill("*** *** 4321");
  await selectAntdOption(page, "paymentAccount_scope", "REGISTRATION");
  await selectAntdOption(page, "paymentAccount_eventId", String(shared.eventId));
  const active = page.locator("#paymentAccount_active");
  if ((await active.getAttribute("aria-checked")) !== "true") {
    await active.click();
  }
  await expect(active).toHaveAttribute("aria-checked", "true");
  await page
    .getByTestId("payment-account-qr-input")
    .setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: makePng(pngSeed(0)) });
  await page.getByTestId("payment-account-submit").click();

  await expect(page.locator('[data-testid^="payment-account-row-"]').filter({ hasText: accountName })).toBeVisible();
  await context.close();
});

test("OPS 开放报名", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await openRegistration(page, shared.eventId);
  await context.close();
});

test("跑者 A 两人同单用百分比优惠码下单，付款页金额与算价一致并上传凭证", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, runnerA, `/events/${slug}`);

  await page.getByTestId("register-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/register$`));

  await ensureParticipants(page, 2);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.categoryId));
  await fillControl(page.getByTestId("participant-1-category"), String(shared.categoryId));
  await page.getByTestId("wizard-next").click();

  await fillParticipant(page, 0, { fullName: "Dara Sok", gender: "M", birthDate: "1990-05-01", idNo: `P${RUN}01`, phone: "+85512345678" });
  await fillParticipant(page, 1, { fullName: "Mealea Sok", gender: "F", birthDate: "1992-08-15", idNo: `P${RUN}02`, phone: "+85512345679" });
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("coupon-input").fill(percentCode);
  await page.getByTestId("coupon-apply").click();
  await expect(page.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("quote-list-amount")).toHaveText("$50.00");
  await expect(page.getByTestId("quote-discount")).toContainText("5.00");
  await expect(page.getByTestId("quote-amount")).toHaveText("$45.00");
  const quoteCents = parseUsdCents(await page.getByTestId("quote-amount").innerText());

  await checkConsents(page);
  await page.getByTestId("order-submit").click();

  await expect(page).toHaveURL(/\/orders\/WR[0-9A-Z]{8}\/pay$/);
  shared.orderNo = (await page.getByTestId("pay-order-no").innerText()).trim();
  expect(shared.orderNo).toMatch(/^WR[0-9A-Z]{8}$/);
  expect(new URL(page.url()).pathname).toBe(`/orders/${shared.orderNo}/pay`);
  await expect(page.getByTestId("pay-qr")).toBeVisible();
  await expect(page.getByTestId("pay-countdown")).toBeVisible();

  // 算价预览不含识别分，付款页应付比算价少 1–50 分（契约补充 8）
  shared.dueCents = parseUsdCents(await page.getByTestId("pay-amount").innerText());
  const identOffset = quoteCents - shared.dueCents;
  expect(identOffset).toBeGreaterThanOrEqual(1);
  expect(identOffset).toBeLessThanOrEqual(50);

  await page.getByTestId("pay-upload-link").click();
  await expect(page).toHaveURL(new RegExp(`/orders/${shared.orderNo}/proof$`));
  await uploadProof(page, `E2E${RUN}A`, makePng(pngSeed(1)));

  await context.close();
});

test("FINANCE 以 UNREADABLE 驳回凭证", async ({ browser }) => {
  const { context, page } = await adminSession(browser, FINANCE.username, FINANCE.password);

  await openSubmittedProof(page, shared.orderNo);
  await page.getByTestId("proof-reject-open").click();
  await selectAntdOption(page, "reject_rejectCode", "UNREADABLE");
  await page.locator("#reject_rejectReason").fill(rejectReason);
  await page.getByTestId("proof-reject-submit").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-status", "REJECTED");
  await expect(page.getByTestId("proof-reject-open")).toHaveCount(0);

  await context.close();
});

test("跑者看到驳回原因并用新交易号重传", async ({ browser }) => {
  const { context, page } = await runnerPage(browser, runnerA, `/orders/${shared.orderNo}`);

  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PROOF_REJECTED");
  await expect(page.getByTestId("order-reject-reason")).toContainText(rejectReason);
  await page.getByTestId("order-reupload").click();
  await expect(page).toHaveURL(new RegExp(`/orders/${shared.orderNo}/proof$`));
  await uploadProof(page, `E2E${RUN}B`, makePng(pngSeed(2)));

  await context.close();
});

test("FINANCE 按应付金额通过", async ({ browser }) => {
  const { context, page } = await adminSession(browser, FINANCE.username, FINANCE.password);

  await openSubmittedProof(page, shared.orderNo);
  await page.getByTestId("proof-approve-open").click();
  await page.locator("#approve_receivedUsd").fill(centsToPlainUsd(shared.dueCents));
  await fillDate(page, "#approve_receivedAt", pickerNow());
  await page.getByTestId("proof-approve-submit").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-status", "APPROVED");

  await context.close();
});

test("跑者订单显示已确认和参赛凭证", async ({ browser }) => {
  const { context, page } = await runnerPage(browser, runnerA, `/orders/${shared.orderNo}`);

  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  await expect(page.getByTestId("order-ticket-qr")).toHaveCount(2);

  await openAsRunner(page, runnerA, "/orders");
  await expect(page.getByTestId(`order-item-${shared.orderNo}`)).toBeVisible();

  await context.close();
});

test("免单码下单直接显示已确认", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, runnerB, `/events/${slug}`);

  await page.getByTestId("register-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/register$`));
  await ensureParticipants(page, 1);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.categoryId));
  await page.getByTestId("wizard-next").click();

  await fillParticipant(page, 0, { fullName: "Sophea Chan", gender: "F", birthDate: "1995-03-20", idNo: `P${RUN}03`, phone: "+85512345680" });
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("coupon-input").fill(waiverCode);
  await page.getByTestId("coupon-apply").click();
  await expect(page.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("quote-amount")).toHaveText("$0.00");
  await checkConsents(page);
  await page.getByTestId("order-submit").click();

  // 应付为 0 跳到订单详情或付款页（契约补充 8），两者都接受后直接打开订单详情
  await page.waitForURL(/\/orders\/WR[0-9A-Z]{8}(\/pay)?$/);
  const match = /\/orders\/(WR[0-9A-Z]{8})/.exec(new URL(page.url()).pathname);
  expect(match).not.toBeNull();
  const waiverOrderNo = match![1]!;

  await openAsRunner(page, runnerB, `/orders/${waiverOrderNo}`);
  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  await expect(page.getByTestId("order-ticket-qr")).toHaveCount(1);
  await expect(page.getByTestId("order-pay")).toHaveCount(0);

  await context.close();
});
