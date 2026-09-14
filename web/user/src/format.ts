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
