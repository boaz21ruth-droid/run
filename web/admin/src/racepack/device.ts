const DEVICE_KEY = "werun.racepack.device";

/**
 * 核销设备 ID：每台手机 / 电脑第一次打开核销站时生成并记在本机，写进扫码流水，
 * 多个柜台同时发放时能分清是哪台设备发的。存储不可用（无痕模式）时退化为本次会话内有效。
 */
let fallback: string | null = null;

export function deviceId(): string {
  try {
    const saved = window.localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const id = `web-${crypto.randomUUID().slice(0, 8)}`;
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    fallback ??= `web-${crypto.randomUUID().slice(0, 8)}`;
    return fallback;
  }
}
