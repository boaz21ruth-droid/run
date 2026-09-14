import i18next, { type i18n } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import enAdmin from "../locales/en/admin.json";
import enCommon from "../locales/en/common.json";
import enUser from "../locales/en/user.json";
import kmAdmin from "../locales/km/admin.json";
import kmCommon from "../locales/km/common.json";
import kmUser from "../locales/km/user.json";
import zhAdmin from "../locales/zh/admin.json";
import zhCommon from "../locales/zh/common.json";
import zhUser from "../locales/zh/user.json";

export type Lang = "zh" | "en" | "km";

export const LANGS: readonly Lang[] = ["zh", "en", "km"];
export const DEFAULT_LANG: Lang = "km";
export const STORAGE_KEY = "werun.lang";
export const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "EN", km: "ខ្មែរ" };

const resources = {
  zh: { common: zhCommon, user: zhUser, admin: zhAdmin },
  en: { common: enCommon, user: enUser, admin: enAdmin },
  km: { common: kmCommon, user: kmUser, admin: kmAdmin },
};

let instance: i18n | null = null;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLang(stored) ? stored : DEFAULT_LANG;
  } catch {
    // 部分浏览器的隐私模式禁用 localStorage，此时使用默认语言
    return DEFAULT_LANG;
  }
}

export function applyDocumentLang(lang: Lang): void {
  const root = document.documentElement;
  root.lang = lang;
  if (lang === "km") {
    root.dataset.script = "khmer";
  } else {
    delete root.dataset.script;
  }
}

export function initI18n(app: "user" | "admin"): i18n {
  const lang = readStoredLang();
  const created = i18next.createInstance();
  void created.use(initReactI18next).init({
    resources,
    lng: lang,
    fallbackLng: ["en", "zh"],
    supportedLngs: [...LANGS],
    ns: ["common", app],
    defaultNS: app,
    fallbackNS: "common",
    interpolation: { escapeValue: false },
    // 资源已内联，关闭异步初始化，调用返回时即可使用 t()
    initAsync: false,
  });
  instance = created;
  applyDocumentLang(lang);
  return created;
}

export function currentLang(): Lang {
  const lang = instance?.language;
  return isLang(lang) ? lang : readStoredLang();
}

export async function setLanguage(lang: Lang): Promise<void> {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage 不可用时语言只在本次打开期间生效
  }
  applyDocumentLang(lang);
  if (instance) {
    await instance.changeLanguage(lang);
  }
}

export function useLang(): Lang {
  const { i18n: active } = useTranslation();
  return isLang(active.language) ? active.language : DEFAULT_LANG;
}
