import { expect, test, type Browser, type Page } from "@playwright/test";
import { ADMIN, ADMIN_URL, FINANCE, OPS, RACE_STAFF } from "./env";
import {
  adminFetch,
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
  RACE_DATE,
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

const shared = { eventId: 0, categoryId: 0, eliteCategoryId: 0, orderNo: "", dueCents: 0 };

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
  await selectAntdOption(page, "priceRule_categoryIds", String(shared.eliteCategoryId), { multiple: true });
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

  await createAndPublishEvent(page, { slug, name: eventName, eventType: "RACE", capacity: 100, eliteCategory: true });
  const detail = await openEventDetail(page, slug);
  shared.eventId = detail.id;
  shared.categoryId = detail.categoryId;
  shared.eliteCategoryId = detail.categoryIds[1] ?? 0;
  expect(shared.eliteCategoryId).toBeGreaterThan(0);

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

test("ADMIN 把现场工作人员指派到赛事", async ({ browser }) => {
  const { context, page } = await adminSession(browser, ADMIN.username, ADMIN.password);
  await page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  await page.getByTestId("event-tab-staff").click();
  const staff = await adminFetch<{ items: { id: number; username: string }[] }>(page, "GET", "/admin/staff");
  const staffId = staff.json.items.find((m) => m.username === RACE_STAFF.username)?.id;
  expect(staffId).toBeDefined();
  await selectAntdOption(page, "assignment_staff", String(staffId));
  await page.getByTestId("assignment-add").click();
  await expect(page.getByText(`${RACE_STAFF.fullName} (${RACE_STAFF.username})`)).toBeVisible();
  await context.close();
});

test("现场工作人员在核销站搜索、本人领取与代领，重复扫码提示已领", async ({ browser }) => {
  // 现场人员只有领物权限，登录后落在核销站
  const { context, page } = await adminSession(browser, RACE_STAFF.username, RACE_STAFF.password, "/racepack");
  await page.goto(`${ADMIN_URL}/racepack?event=${shared.eventId}`);
  await expect(page.getByTestId("racepack-progress")).toHaveText("已发 0 / 3");

  const search = page.getByTestId("racepack-search");
  await search.fill(shared.orderNo);
  await search.press("Enter");
  const cards = page.locator('[data-testid^="racepack-entry-"][data-state]');
  await expect(cards).toHaveCount(2);

  const dara = cards.filter({ hasText: "Dara Sok" });
  await expect(dara).toHaveAttribute("data-state", "ready");
  await dara.getByRole("button", { name: "本人领取" }).click();
  await expect(page.getByText("已发放给 Dara Sok")).toBeVisible();
  await expect(search).toHaveValue("");

  await search.fill("Mealea");
  await search.press("Enter");
  const mealea = cards.filter({ hasText: "Mealea Sok" });
  await mealea.getByRole("button", { name: "他人代领" }).click();
  await mealea.getByPlaceholder("代领人姓名").fill("Chan Sophea");
  await mealea.getByText("代领人出示了跑者的参考码或凭证").click();
  await mealea.getByRole("button", { name: "确认代领发放" }).click();
  await expect(page.getByText("已发放给 Mealea Sok")).toBeVisible();

  await search.fill("Dara Sok");
  await search.press("Enter");
  await expect(cards.filter({ hasText: "Dara Sok" })).toHaveAttribute("data-state", "picked");
  await expect(page.getByTestId("racepack-progress")).toHaveText("已发 2 / 3");
  await expect(page.getByTestId("racepack-recent")).toContainText("代领：Chan Sophea");

  // 现场工作人员没有撤销权限
  await expect(page.getByRole("button", { name: "撤销" })).toHaveCount(0);
  await context.close();
});


// v8 推荐渠道与免费入场：推荐链接带每人固定价 $18 的推荐码（档位此时是标准 $30），免费入场名额 1
const referralSlug = `bkk-${runId}`;
const referralCode = `BKK${RUN}`;
const runnerC = runnerUser("Chenda", "zh");
const kol = runnerUser("Sreyleak", "zh");

test("OPS 在推广页新建推荐链接（每人固定价 $18），开放 1 个免费入场名额", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  await page.getByTestId("event-tab-promo").click();

  await page.getByTestId("referral-create").click();
  await page.locator("#referral_label").fill(`BKK Runners ${runId}`);
  await page.locator("#referral_slug").fill(referralSlug);
  await page.locator("#referral_code").fill(referralCode);
  await page.locator("#referral_discountValue").fill("18");
  await page.getByTestId("referral-submit").click();
  await expect(page.getByTestId(`referral-url-${referralSlug}`)).toBeVisible();

  await page.getByTestId("comp-open").click();
  await fillControl(page.getByTestId("comp-quota"), "1");
  await page.getByTestId("comp-quota-save").click();
  await expect(page.getByTestId("comp-summary")).toHaveText("已批准 0 / 名额 1 · 待审批 0");
  await context.close();
});

test("跑者从推荐链接进来：赛事页显示推荐码，确认页自动用上按 $18 算价，订单归因到链接", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, runnerC, `/r/${referralSlug}`);
  await expect(page).toHaveURL(new RegExp(`/events/${slug}$`));
  await expect(page.getByTestId("referral-banner")).toContainText(referralCode);
  await expect(page.getByTestId("referral-banner")).toContainText("推荐价 $18.00 / 人");

  await page.getByTestId("register-button").click();
  await ensureParticipants(page, 1);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.categoryId));
  await page.getByTestId("wizard-next").click();
  await fillParticipant(page, 0, { fullName: "Chenda Ros", gender: "F", birthDate: "1993-07-02", idNo: `P${RUN}05`, phone: "+85512345681" });
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("coupon-input")).toHaveValue(referralCode);
  await expect(page.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("quote-amount")).toHaveText("$18.00");
  await checkConsents(page);
  await page.getByTestId("order-submit").click();
  await page.waitForURL(/\/orders\/WR[0-9A-Z]{8}(\/pay)?$/);
  await context.close();

  const ops = await adminSession(browser, OPS.username, OPS.password);
  const links = await adminFetch<{ items: { slug: string; clickCount: number; orders: number }[] }>(
    ops.page,
    "GET",
    `/admin/events/${shared.eventId}/referral-links`,
  );
  const link = links.json.items.find((l) => l.slug === referralSlug);
  expect(link).toMatchObject({ clickCount: 1, orders: 1 });
  await ops.context.close();
});

test("KOL 申请免费入场，OPS 批准，KOL 用专属码免费报名并直接确认", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await runnerPage(browser, kol, `/events/${slug}`);
  await page.getByTestId("comp-link").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/comp$`));
  await page.getByTestId("comp-name").fill("Sreyleak K.");
  await page.getByTestId("comp-url").fill("https://instagram.com/sreyleak");
  await page.getByTestId("comp-submit").click();
  await expect(page.getByTestId("comp-pending")).toBeVisible();

  const ops = await adminSession(browser, OPS.username, OPS.password);
  await ops.page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  await ops.page.getByTestId("event-tab-promo").click();
  const list = await adminFetch<{ items: { id: number; applicantName: string }[] }>(
    ops.page,
    "GET",
    `/admin/events/${shared.eventId}/comp-requests`,
  );
  const requestId = list.json.items.find((r) => r.applicantName === "Sreyleak K.")?.id;
  expect(requestId).toBeDefined();
  await ops.page.getByTestId(`comp-approve-${requestId}`).click();
  await expect(ops.page.getByTestId("comp-summary")).toHaveText("已批准 1 / 名额 1 · 待审批 0");
  await ops.context.close();

  await page.reload();
  const code = (await page.getByTestId("comp-code").innerText()).trim();
  expect(code).toMatch(/^COMP-[0-9A-Z]{8}$/);
  await page.getByTestId("comp-register").click();
  await ensureParticipants(page, 1);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.categoryId));
  await page.getByTestId("wizard-next").click();
  await fillParticipant(page, 0, { fullName: "Sreyleak Kim", gender: "F", birthDate: "1997-01-09", idNo: `P${RUN}06`, phone: "+85512345682" });
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("coupon-input")).toHaveValue(code);
  await expect(page.getByTestId("coupon-result")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("quote-amount")).toHaveText("$0.00");
  await checkConsents(page);
  await page.getByTestId("order-submit").click();
  await page.waitForURL(/\/orders\/WR[0-9A-Z]{8}(\/pay)?$/);
  const orderNo = /\/orders\/(WR[0-9A-Z]{8})/.exec(new URL(page.url()).pathname)![1]!;
  await openAsRunner(page, kol, `/orders/${orderNo}`);
  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  await context.close();
});

const eliteRunner = runnerUser("Bopha", "zh");
const eliteNote = `成绩页查不到 ${runId}`;
const elite = { orderNo: "" };

test("OPS 设置退改政策与 5KE 精英组资格（30 分钟以内，不通过转 5K）", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  await page.getByTestId("event-tab-rules").click();

  // 默认两档：14 天前退 80%、7 天前退 50%，接受转让到开赛前 3 天
  await page.getByTestId("refund-enabled").click();
  await expect(page.getByTestId("refund-days-0")).toHaveValue("14");
  await page.getByTestId("refund-save").click();
  await expect(page.getByText("退改政策已保存")).toBeVisible();

  await page.getByTestId("qualify-edit-5KE").click();
  await page.getByTestId("qualify-required").click();
  await page.locator("#qualify_rule_zh").fill("需近两年 5K 30 分钟以内的官方成绩");
  await page.locator("#qualify_rule_en").fill("Official 5K under 30:00 in the last two years");
  await page.locator("#qualify_rule_km").fill("5K ផ្លូវការក្រោម 30:00");
  await page.locator("#qualify_maxTime").fill("30:00");
  await page.getByTestId("qualify-save").click();
  await expect(page.getByText("不通过转到 5K", { exact: true })).toBeVisible();
  await context.close();
});

test("跑者报 5KE：成绩太慢被拦，填好证明后用免单码直接确认，订单显示核验中", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, eliteRunner, `/events/${slug}`);
  await expect(page.getByTestId("category-5KE-qualify")).toContainText("30 分钟以内");
  await expect(page.getByTestId("refund-policy")).toContainText("开赛 14 天前");

  await page.getByTestId("register-button").click();
  await ensureParticipants(page, 1);
  await fillControl(page.getByTestId("participant-0-category"), String(shared.eliteCategoryId));
  await page.getByTestId("participant-0-bestTimeMs").fill("31:00");
  await page.getByTestId("participant-0-proofSource").fill("Mekong Night Run 2025");
  await page.getByTestId("participant-0-proofUrl").fill("https://results.example.kh/5k/123");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("participant-0-qualify")).toContainText("成绩须在 30:00 以内");
  await page.getByTestId("participant-0-bestTimeMs").fill("24:30");
  await page.getByTestId("wizard-next").click();
  await fillParticipant(page, 0, { fullName: "Bopha Chea", gender: "F", birthDate: "1996-04-12", idNo: `P${RUN}07`, phone: "+85512345683" });
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("refund-policy")).toContainText("退 80%");
  await expect(page.getByTestId("refund-policy")).toContainText("开赛 3 天前可转给他人");
  await expect(page.getByTestId("consent-item-results_public")).not.toBeChecked();
  await page.getByTestId("coupon-input").fill(waiverCode);
  await page.getByTestId("coupon-apply").click();
  await expect(page.getByTestId("quote-amount")).toHaveText("$0.00");
  // 可选条目不勾也能提交
  await checkConsents(page);
  await page.getByTestId("order-submit").click();
  await page.waitForURL(/\/orders\/WR[0-9A-Z]{8}(\/pay)?$/);
  elite.orderNo = /\/orders\/(WR[0-9A-Z]{8})/.exec(new URL(page.url()).pathname)![1]!;

  await openAsRunner(page, eliteRunner, `/orders/${elite.orderNo}`);
  await expect(page.getByTestId("order-status")).toHaveAttribute("data-status", "PAID");
  await expect(page.locator('[data-testid^="qualify-"]')).toContainText("精英组资格核验中");
  await context.close();
});

test("OPS 核验不通过：报名转到 5K，跑者订单显示已转组和原因", async ({ browser }) => {
  const ops = await adminSession(browser, OPS.username, OPS.password);
  await ops.page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  await ops.page.getByTestId("event-tab-rules").click();
  const proofs = await adminFetch<{ items: { id: number; fullName: string; status: string }[] }>(
    ops.page,
    "GET",
    `/admin/events/${shared.eventId}/qualification-proofs`,
  );
  const proof = proofs.json.items.find((p) => p.fullName === "Bopha Chea");
  expect(proof?.status).toBe("PENDING");
  await ops.page.getByTestId(`proof-reject-${proof!.id}`).click();
  await ops.page.getByTestId("proof-reject-note").fill(eliteNote);
  await ops.page.getByTestId("proof-reject-confirm").click();
  await expect(ops.page.getByText("已转到 5K", { exact: true })).toBeVisible();
  await ops.context.close();

  const { context, page } = await runnerPage(browser, eliteRunner, `/orders/${elite.orderNo}`);
  const status = page.locator('[data-testid^="qualify-"]');
  await expect(status).toContainText("资格未通过");
  await expect(status).toContainText(eliteNote);
  await expect(page.getByRole("row", { name: /Bopha Chea/ })).toContainText("欢乐 5K");
  await context.close();
});

const volunteer = runnerUser("Rotha", "zh");
const volunteerRole = { zh: `检录台 ${runId}`, en: `Check-in ${runId}`, km: `ចុះឈ្មោះ ${runId}` };

test("OPS 开放志愿者招募（比赛日）并新建检录台岗位（2 席）", async ({ browser }) => {
  const { context, page } = await adminSession(browser, OPS.username, OPS.password);
  await page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  const settings = await adminFetch(page, "PUT", `/admin/events/${shared.eventId}/volunteer-settings`, {
    open: true,
    dates: [RACE_DATE],
    note: { zh: "需柬英双语 · 提供 T 恤与餐食", en: "Khmer and English · T-shirt and meals", km: "ខ្មែរ និងអង់គ្លេស" },
  });
  expect(settings.status).toBe(200);

  await page.getByTestId("event-tab-volunteers").click();
  await page.getByTestId("volunteer-role-create").click();
  await page.locator("#volunteerRole_name_zh").fill(volunteerRole.zh);
  await page.locator("#volunteerRole_name_en").fill(volunteerRole.en);
  await page.locator("#volunteerRole_name_km").fill(volunteerRole.km);
  await page.locator("#volunteerRole_schedule_zh").fill("16:00 起 · 核对参考码与证件");
  await fillControl(page.locator("#volunteerRole_capacity"), "2");
  await page.getByTestId("volunteer-role-submit").click();
  await expect(page.getByText(volunteerRole.zh, { exact: true })).toBeVisible();
  await context.close();
});

test("跑者申请志愿者，OPS 分配到检录台，跑者看到自己的岗位", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await runnerPage(browser, volunteer, `/events/${slug}`);
  await page.getByTestId("volunteer-link").click();
  await expect(page).toHaveURL(new RegExp(`/events/${slug}/volunteer$`));
  await expect(page.getByText("需柬英双语 · 提供 T 恤与餐食")).toBeVisible();
  const role = page.locator('[data-testid^="volunteer-role-"]').filter({ hasText: volunteerRole.zh });
  await expect(role).toContainText("2");
  await role.getByRole("checkbox").check();
  await page.getByTestId("volunteer-name").fill("Rotha Chan");
  await page.getByTestId("volunteer-phone").fill("+855 12 555 777");
  await page.getByTestId("volunteer-agree-conduct").check();
  await page.getByTestId("volunteer-agree-seats").check();
  await page.getByTestId("volunteer-submit").click();
  await expect(page.getByTestId("volunteer-status")).toHaveAttribute("data-status", "PENDING");

  const ops = await adminSession(browser, OPS.username, OPS.password);
  await ops.page.goto(`${ADMIN_URL}/events/${shared.eventId}`);
  await ops.page.getByTestId("event-tab-volunteers").click();
  const boardData = await adminFetch<{ applications: { id: number; fullName: string }[] }>(
    ops.page,
    "GET",
    `/admin/events/${shared.eventId}/volunteers`,
  );
  const appId = boardData.json.applications.find((a) => a.fullName === "Rotha Chan")?.id;
  expect(appId).toBeDefined();
  await ops.page.getByTestId(`volunteer-assign-${appId}`).click();
  await expect(ops.page.getByTestId("volunteer-summary")).toContainText("已分配 1");
  await ops.context.close();

  await page.reload();
  await expect(page.getByTestId("volunteer-assigned")).toContainText(volunteerRole.zh);
  await context.close();
});
