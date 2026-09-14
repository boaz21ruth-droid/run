// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANG,
  LANGS,
  STORAGE_KEY,
  applyDocumentLang,
  currentLang,
  initI18n,
  isLang,
  setLanguage,
} from "./index";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("lang");
  delete document.documentElement.dataset.script;
});

describe("常量", () => {
  it("只支持三种语言，默认高棉文", () => {
    expect(LANGS).toEqual(["zh", "en", "km"]);
    expect(DEFAULT_LANG).toBe("km");
    expect(STORAGE_KEY).toBe("werun.lang");
    expect(isLang("zh")).toBe(true);
    expect(isLang("zh-CN")).toBe(false);
  });
});

describe("initI18n", () => {
  it("使用 localStorage 中保存的语言，并同步 html 属性", () => {
    window.localStorage.setItem(STORAGE_KEY, "zh");
    const i18n = initI18n("user");
    expect(i18n.language).toBe("zh");
    expect(currentLang()).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");
    expect(document.documentElement.dataset.script).toBeUndefined();
    expect(i18n.t("common:nav.events")).toBe("赛事");
    expect(i18n.t("home.title")).toBe("近期赛事");
  });

  it("没有保存或保存了无效值时使用高棉文", () => {
    window.localStorage.setItem(STORAGE_KEY, "fr");
    const i18n = initI18n("admin");
    expect(i18n.language).toBe("km");
    expect(document.documentElement.lang).toBe("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
  });

  it("后台实例的默认命名空间是 admin", () => {
    window.localStorage.setItem(STORAGE_KEY, "en");
    const i18n = initI18n("admin");
    expect(i18n.t("login.submit")).toBe("Sign in");
  });
});

describe("setLanguage", () => {
  it("切换语言、写入存储并更新 html 属性", async () => {
    window.localStorage.setItem(STORAGE_KEY, "km");
    const i18n = initI18n("user");
    await setLanguage("en");
    expect(i18n.language).toBe("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dataset.script).toBeUndefined();
    expect(i18n.t("events.title")).toBe("All events");

    await setLanguage("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
  });
});

describe("applyDocumentLang", () => {
  it("只在高棉文时设置 data-script", () => {
    applyDocumentLang("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
    applyDocumentLang("zh");
    expect(document.documentElement.dataset.script).toBeUndefined();
  });
});
