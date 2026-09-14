const USD_INPUT = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** 美分 → "$25.00"；负数 → "-$0.05"。不加千分位，便于与接口金额逐字比对 */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}$${dollars}.${String(rest).padStart(2, "0")}`;
}

/** 美元字符串 → 美分，按字符串解析不经过浮点。只接受非负数、至多两位小数；非法时返回 null */
export function parseUsdToCents(input: string): number | null {
  const match = USD_INPUT.exec(input.trim());
  if (!match) {
    return null;
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(whole) * 100 + Number(fraction);
}
