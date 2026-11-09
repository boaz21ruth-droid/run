import type { HTMLAttributes, KeyboardEvent } from "react";
import { formatInTimezone } from "../time/eventTime";

/** 2451 → "24.51"；只用整数运算 */
export function centsToUsdInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, "0")}`;
}

/** 按赛事时区（不是浏览器时区）显示到分钟；空值显示破折号 */
export function formatDateTime(iso: string | null | undefined, tz: string): string {
  return formatInTimezone(iso, tz);
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

/**
 * 可点击的表格行同时支持键盘：行可聚焦（tabIndex=0），Enter 打开详情。
 * 只响应行本身的按键，行内按钮/链接的 Enter 不会被劫持。
 */
export function clickableRowProps(open: () => void, style?: HTMLAttributes<HTMLElement>["style"]): HTMLAttributes<HTMLElement> {
  return {
    onClick: open,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" && event.target === event.currentTarget) {
        event.preventDefault();
        open();
      }
    },
    tabIndex: 0,
    style: { cursor: "pointer", ...style },
  };
}
