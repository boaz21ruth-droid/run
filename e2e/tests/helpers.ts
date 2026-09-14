import { expect, type BrowserContext, type Page } from "@playwright/test";
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
