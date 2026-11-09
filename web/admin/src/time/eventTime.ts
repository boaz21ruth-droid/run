import dayjs, { type Dayjs } from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 与后端 events.timezone 的默认值一致（api/internal/notify/model.go DefaultTimezone）。
 * 新建赛事时接口还不接受时区，服务端按这个时区落库；没有时区信息的列表也按它显示。
 */
export const DEFAULT_TIMEZONE = "Asia/Phnom_Penh";

const WALL_CLOCK = "YYYY-MM-DDTHH:mm:ss";
const DISPLAY = "YYYY-MM-DD HH:mm";

/**
 * antd DatePicker 只会产出浏览器本地时区的 Dayjs。这里约定表单里的 Dayjs 只当“墙上时间”用：
 * 年月日时分就是赛事时区下的读数，本身的时区偏移忽略。
 *
 * ISO 时刻 → 赛事时区下的墙上时间（供 DatePicker 回填）。
 */
export function toEventWallClock(iso: string, tz: string): Dayjs {
  return dayjs(dayjs(iso).tz(tz).format(WALL_CLOCK));
}

/** DatePicker 的墙上时间按赛事时区解释 → UTC ISO 字符串（与 Date#toISOString 格式一致） */
export function fromEventWallClock(value: Dayjs, tz: string): string {
  return dayjs.tz(value.format(WALL_CLOCK), tz).toISOString();
}

/** 可空版本，表单转换器用 */
export function toEventWallClockOrNull(iso: string | null | undefined, tz: string): Dayjs | null {
  return iso ? toEventWallClock(iso, tz) : null;
}

export function fromEventWallClockOrNull(value: Dayjs | null | undefined, tz: string): string | null {
  return value ? fromEventWallClock(value, tz) : null;
}

/** 按赛事时区显示到分钟；空值显示破折号 */
export function formatInTimezone(iso: string | null | undefined, tz: string): string {
  return iso ? dayjs(iso).tz(tz).format(DISPLAY) : "—";
}

/** "Asia/Phnom_Penh (UTC+7)"；偏移按给定时刻（默认现在）计算，夏令时地区会随日期变化 */
export function timezoneLabel(tz: string, at: string | number | Date = Date.now()): string {
  const offset = dayjs(at).tz(tz).utcOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${tz} (UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""})`;
}
