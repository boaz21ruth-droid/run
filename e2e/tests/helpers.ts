import { crc32, deflateSync } from "node:zlib";
import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_URL } from "./env";

/**
 * 在页面脚本执行前写入语言，保证每个上下文的初始语言确定。
 *
 * `addInitScript` 会在该上下文里每次导航（包括 `page.reload()`）前重新执行，
 * 不是只执行一次。如果无条件写入，reload 时会把用户在页面里切换后写入的
 * `werun.lang` 覆盖回这里的初始值。所以只在键不存在时写入，保证首次加载的
 * 初始语言确定，同时不影响页面运行时自己写入的语言。
 */
export async function presetLanguage(context: BrowserContext, lang: "zh" | "en" | "km"): Promise<void> {
  await context.addInitScript((value) => {
    if (window.localStorage.getItem("werun.lang") === null) {
      window.localStorage.setItem("werun.lang", value);
    }
  }, lang);
}

export async function loginAdmin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);
}

/**
 * AntD DatePicker：输入文本后用 Tab 提交确认。selector 形如 "#event_raceDate"
 *
 * 没有用 Enter：表单里只有 slug/姓名/城市/比赛日期/组别必填项是必填的，
 * startAt/cutoffAt 不是必填项；当这些必填项都已填好时，在日期输入框按 Enter
 * 会触发 antd 表单的默认提交（浏览器原生行为），导致表单在 cutoffAt 填完之前
 * 就被提交并跳转，而不是仅仅关闭 DatePicker 面板。改用 Tab 把焦点移出输入框，
 * 同样能让 DatePicker 提交已输入的文本，但不会触发表单提交。
 */
export async function fillDate(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.click();
  await input.fill(value);
  await input.press("Tab");
}

/** 新建 zh 语言的上下文并以员工身份登录 */
export async function adminSession(
  browser: Browser,
  username: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await presetLanguage(context, "zh");
  const page = await context.newPage();
  await loginAdmin(page, username, password);
  return { context, page };
}

/** 在已登录的后台页面里调用接口（带会话 Cookie 与 X-WeRun-Client） */
export async function adminFetch<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const result = await page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", "Accept-Language": "zh", "X-WeRun-Client": "admin" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
    },
    { method, path, body },
  );
  return { status: result.status, json: result.json as T };
}

/**
 * 按选项 value 选择 antd Select，不依赖选项文案（契约补充 8）。
 * rc-select 打开后，输入框的 aria-activedescendant 指向一个隐藏的无障碍节点，
 * 节点文本就是当前高亮选项的 value；逐个 ArrowDown 直到匹配再 Enter。
 * 多选：已选中（aria-selected="true"）时不再按 Enter（否则会取消选择），最后 Escape 关闭下拉。
 * 选项可能异步加载（如赛事下拉），所以用 expect.poll 在超时内反复尝试，而不是固定等待。
 */
export async function selectAntdOption(
  page: Page,
  inputId: string,
  value: string,
  options: { multiple?: boolean } = {},
): Promise<void> {
  const input = page.locator(`#${inputId}`);
  // 已有值时选中项的 span 盖在输入框上，点输入框会被拦截；点外层 selector 打开下拉
  await input.locator("xpath=ancestor::div[contains(concat(' ', @class, ' '), ' ant-select-selector ')][1]").click();
  await expect(input).toHaveAttribute("aria-activedescendant", /_list_\d+$/);
  await expect
    .poll(
      async () => {
        const activeId = await input.getAttribute("aria-activedescendant");
        const active = page.locator(`[id="${activeId ?? ""}"]`);
        if (activeId !== null && (await active.count()) > 0 && (await active.textContent()) === value) {
          return (await active.getAttribute("aria-selected")) === "true" ? "selected" : "active";
        }
        await input.press("ArrowDown");
        return "moving";
      },
      // 每轮最多移动一格；列表较长（本地多次运行累积的赛事）时需要足够的轮数
      { message: `antd Select #${inputId} 中找不到 value=${value} 的选项`, intervals: [50], timeout: 20_000 },
    )
    .not.toBe("moving");

  if (!options.multiple) {
    await input.press("Enter");
    return;
  }
  const activeId = await input.getAttribute("aria-activedescendant");
  if ((await page.locator(`[id="${activeId ?? ""}"]`).getAttribute("aria-selected")) !== "true") {
    await input.press("Enter");
  }
  await input.press("Escape");
}

/** 用户端原生控件：<select> 用 selectOption，其余用 fill */
export async function fillControl(locator: Locator, value: string): Promise<void> {
  const tag = await locator.evaluate((el) => el.tagName);
  if (tag === "SELECT") {
    await locator.selectOption(value);
  } else {
    await locator.fill(value);
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 运行时生成一张 2×2 的 RGB PNG，颜色取 seed 的低 24 位。
 * 不同 seed 的文件 sha256 不同，重传时不会触发重复截图标记；服务端能解码出宽高。
 */
export function makePng(seed: number): Buffer {
  const width = 2;
  const height = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 真彩色 RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const rowLength = 1 + width * 3;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowLength;
    raw[row] = 0; // 过滤类型 None
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = seed & 0xff;
      raw[offset + 1] = (seed >> 8) & 0xff;
      raw[offset + 2] = (seed >> 16) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface NewEvent {
  slug: string;
  name: { zh: string; en: string; km: string };
  eventType: "RACE" | "FREE_ACTIVITY";
  capacity: number;
}

/** OPS 已登录：新建赛事（一个组别）并发布 */
export async function createAndPublishEvent(page: Page, ev: NewEvent): Promise<void> {
  await page.goto(`${ADMIN_URL}/events`);
  await page.getByTestId("event-create-button").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events/new`);

  await page.locator("#event_slug").fill(ev.slug);
  if (ev.eventType !== "RACE") {
    await selectAntdOption(page, "event_eventType", ev.eventType);
  }
  await page.locator("#event_name_zh").fill(ev.name.zh);
  await page.locator("#event_name_en").fill(ev.name.en);
  await page.locator("#event_name_km").fill(ev.name.km);
  await page.locator("#event_city").fill("Phnom Penh");
  await fillDate(page, "#event_raceDate", "2027-01-17");

  await page.locator("#event_categories_0_code").fill("5K");
  await page.locator("#event_categories_0_name_zh").fill("欢乐 5K");
  await page.locator("#event_categories_0_name_en").fill("Fun 5K");
  await page.locator("#event_categories_0_name_km").fill("រត់ 5K");
  await page.locator("#event_categories_0_distanceM").fill("5000");
  await page.locator("#event_categories_0_capacity").fill(String(ev.capacity));
  await fillDate(page, "#event_categories_0_startAt", "2027-01-17 06:00");
  await fillDate(page, "#event_categories_0_cutoffAt", "2027-01-17 08:00");

  await page.getByTestId("event-form-submit").click();
  await expect(page).toHaveURL(`${ADMIN_URL}/events`);

  const publish = page.getByTestId(`event-publish-${ev.slug}`);
  await expect(publish).toBeVisible();
  await publish.click();
  await expect(publish).toBeHidden();
}

/** 从赛事列表进入详情，返回赛事 id 与第一个组别 id */
export async function openEventDetail(page: Page, slug: string): Promise<{ id: number; categoryId: number }> {
  await page.goto(`${ADMIN_URL}/events`);
  await page.getByTestId(`event-open-${slug}`).click();
  await expect(page).toHaveURL(/\/events\/\d+$/);
  const match = /\/events\/(\d+)$/.exec(new URL(page.url()).pathname);
  if (!match) {
    throw new Error(`赛事详情地址不含 id：${page.url()}`);
  }
  const id = Number(match[1]);
  const detail = await adminFetch<{ categories: { id: number }[] }>(page, "GET", `/admin/events/${id}`);
  expect(detail.status).toBe(200);
  const category = detail.json.categories[0];
  if (!category) {
    throw new Error(`赛事 ${slug} 没有组别`);
  }
  return { id, categoryId: category.id };
}

/** OPS 已登录：打开报名开关并保存，刷新后确认已持久化 */
export async function openRegistration(page: Page, eventId: number): Promise<void> {
  await page.goto(`${ADMIN_URL}/events/${eventId}`);
  const toggle = page.getByTestId("event-registration-switch");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  const saved = page.waitForResponse(
    (res) =>
      /\/api\/admin\/events\/\d+\/registration$/.test(new URL(res.url()).pathname) && res.request().method() === "PATCH",
  );
  await page.getByTestId("event-registration-save").click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("event-registration-not-ready")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("event-registration-switch")).toHaveAttribute("aria-checked", "true");
}

/** "$44.99" / "-$5.00" / "44.99" → 4499 / 500 / 4499（只取数值部分） */
export function parseUsdCents(text: string): number {
  const match = /(\d+)\.(\d{2})/.exec(text);
  if (!match) {
    throw new Error(`不是美元金额：${text}`);
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

/** 4499 → "44.99"（后台与上传页的美元输入框格式） */
export function centsToPlainUsd(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** 本地时间 "YYYY-MM-DD HH:mm"，默认为 1 分钟前（到账时间不能晚于现在） */
export function pickerNow(offsetMinutes = -1): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
