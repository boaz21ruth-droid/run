import { describe, expect, it } from "vitest";
import { formatKm, formatRaceDate, formatTime } from "./format";

describe("formatTime", () => {
  it("按金边时间（UTC+7）显示 24 小时制时间", () => {
    expect(formatTime("2026-11-14T23:00:00Z", "en")).toBe("06:00");
    expect(formatTime("2026-11-15T02:30:00Z", "zh")).toBe("09:30");
  });
});

describe("formatRaceDate", () => {
  it("日期不受时区影响", () => {
    expect(formatRaceDate("2026-11-15", "en")).toBe("15 November 2026");
    expect(formatRaceDate("2026-11-15", "zh")).toBe("2026年11月15日");
  });
});

describe("formatKm", () => {
  it("米换算成公里，最多一位小数", () => {
    expect(formatKm(21097, "en")).toBe("21.1");
    expect(formatKm(10000, "en")).toBe("10");
  });
});
