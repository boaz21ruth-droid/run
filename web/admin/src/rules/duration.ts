const DURATION = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

/** 「1:45:00」「45:00」解析为毫秒；格式不对返回 null（与用户站 rules/duration 一致） */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text.trim());
  if (!match) {
    return null;
  }
  const ms = (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
