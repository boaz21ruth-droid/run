import type { Schemas } from "@werun/api-client";
import type { Lang } from "@werun/i18n";

const RACE_TIME_ZONE = "Asia/Phnom_Penh";

const INTL_LOCALES: Record<Lang, string> = {
  zh: "zh-CN",
  en: "en-GB",
  km: "km-KH",
};

/** "2026-11-15" 这类纯日期按 UTC 解析并按 UTC 显示，避免跨时区时日期偏移一天 */
export function formatRaceDate(isoDate: string, lang: Lang): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** 发枪、关门时间一律按赛事所在地金边时间显示 */
export function formatTime(isoDateTime: string, lang: Lang): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: RACE_TIME_ZONE,
  }).format(new Date(isoDateTime));
}

export function formatKm(distanceM: number, lang: Lang): string {
  return new Intl.NumberFormat(INTL_LOCALES[lang], { maximumFractionDigits: 1 }).format(distanceM / 1000);
}

export function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(INTL_LOCALES[lang]).format(value);
}

/** 三语文本按当前语言显示，缺失时依次回退英文、中文、高棉文 */
export function pickText(text: Schemas["LocalizedText"], lang: Lang): string {
  return text[lang] ?? text.en ?? text.zh ?? text.km ?? "";
}

/** 赛事日期拆成"大日 + 小月"给卡片与首屏用；full 是完整可读日期，供屏幕阅读器 */
export function raceDayParts(isoDate: string, lang: Lang): { day: string; month: string; full: string } {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return {
    day: new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(date),
    month: new Intl.DateTimeFormat(INTL_LOCALES[lang], { month: "short", timeZone: "UTC" }).format(date),
    full: formatRaceDate(isoDate, lang),
  };
}

/** 截止时间、下单时间等按浏览器时区显示 */
export function formatDateTime(isoDateTime: string, lang: Lang): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(isoDateTime));
}
