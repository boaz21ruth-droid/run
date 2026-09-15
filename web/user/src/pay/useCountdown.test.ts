import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCountdown, useCountdown } from "./useCountdown";

describe("formatCountdown", () => {
  it("不足一小时显示 mm:ss，超过一小时显示 h:mm:ss", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(5)).toBe("00:05");
    expect(formatCountdown(1800)).toBe("30:00");
    expect(formatCountdown(3599)).toBe("59:59");
    expect(formatCountdown(3661)).toBe("1:01:01");
    expect(formatCountdown(86400)).toBe("24:00:00");
  });
});

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-14T03:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("每秒递减，到期后停在 0", () => {
    const { result } = renderHook(() => useCountdown("2026-09-14T03:00:02Z"));
    expect(result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(0);
  });

  it("没有截止时间时返回 null", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBeNull();
  });
});
