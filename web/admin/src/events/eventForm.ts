import type { Schemas } from "@werun/api-client";
import type { Dayjs } from "dayjs";
import { DEFAULT_TIMEZONE, fromEventWallClockOrNull } from "../time/eventTime";

export interface LocalizedValues {
  zh: string;
  en: string;
  km: string;
}

export interface CategoryFormValues {
  code: string;
  name: LocalizedValues;
  distanceM: number;
  capacity: number;
  startAt?: Dayjs | null;
  cutoffAt?: Dayjs | null;
}

export interface EventFormValues {
  slug: string;
  eventType: Schemas["CreateEventRequest"]["eventType"];
  organizerType: Schemas["CreateEventRequest"]["organizerType"];
  name: LocalizedValues;
  city: string;
  raceDate: Dayjs;
  categories?: CategoryFormValues[];
}

export function emptyCategory(): Partial<CategoryFormValues> {
  return { name: { zh: "", en: "", km: "" } };
}

function trimText(text: LocalizedValues): LocalizedValues {
  return { zh: text.zh.trim(), en: text.en.trim(), km: text.km.trim() };
}

/**
 * 组别开跑 / 关门时间按赛事时区解释。新建接口还不接受 timezone，服务端按默认时区（Asia/Phnom_Penh）建赛事，
 * 所以这里默认用 DEFAULT_TIMEZONE。
 */
export function toCreateEventRequest(values: EventFormValues, tz: string = DEFAULT_TIMEZONE): Schemas["CreateEventRequest"] {
  return {
    slug: values.slug.trim(),
    eventType: values.eventType,
    organizerType: values.organizerType,
    name: trimText(values.name),
    city: values.city.trim(),
    raceDate: values.raceDate.format("YYYY-MM-DD"),
    categories: (values.categories ?? []).map((category) => ({
      code: category.code.trim(),
      name: trimText(category.name),
      distanceM: category.distanceM,
      capacity: category.capacity,
      startAt: fromEventWallClockOrNull(category.startAt, tz),
      cutoffAt: fromEventWallClockOrNull(category.cutoffAt, tz),
    })),
  };
}

/** 服务端字段路径 → antd Form NamePath："categories[0].code" 与 "categories.0.code" 都得到 ["categories", 0, "code"] */
export function toNamePath(field: string): (string | number)[] {
  return field
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((part) => part !== "")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}
