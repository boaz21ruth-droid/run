import { useEffect, useState } from "react";

/** 每 intervalMs 毫秒更新一次的当前时间，让“已等待 N 分钟”这类显示自己走动 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
