import dayjs from "dayjs";
import type { HTMLAttributes } from "react";

/** 2451 → "24.51"；只用整数运算 */
export function centsToUsdInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, "0")}`;
}

/** 按浏览器时区显示到分钟；空值显示破折号 */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dayjs(iso).format("YYYY-MM-DD HH:mm") : "—";
}

export function waitingParts(sinceIso: string, nowMs: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.floor((nowMs - Date.parse(sinceIso)) / 60_000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** antd Table onRow 用：对象字面量里写 data-* 会触发多余属性检查，这里用 Object.assign 附加 */
export function rowProps(
  testId: string,
  attrs: HTMLAttributes<HTMLElement>,
  data: Record<`data-${string}`, string> = {},
): HTMLAttributes<HTMLElement> {
  return Object.assign(attrs, { "data-testid": testId }, data);
}
