const DURATION = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

/** 「1:41:20」「41:20」解析为毫秒；格式不对返回 null */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text.trim());
  if (!match) {
    return null;
  }
  const ms = (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  return ms > 0 ? ms : null;
}

/** 毫秒格式化为 h:mm:ss（不足一小时为 m:ss），与后端 formatDuration 一致 */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
