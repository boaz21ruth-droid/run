import { useEffect, useState } from "react";

/** 距 deadlineAt 的剩余秒数（不小于 0），每秒刷新；deadlineAt 为空或无法解析时返回 null */
export function useCountdown(deadlineAt: string | null | undefined): number | null {
  const parsed = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  const deadline = Number.isNaN(parsed) ? null : parsed;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  if (deadline === null) {
    return null;
  }
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
