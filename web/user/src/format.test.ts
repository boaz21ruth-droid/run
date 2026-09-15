import { describe, expect, it } from "vitest";
import { formatDateTime, formatKm, formatRaceDate, formatTime, pickText } from "./format";

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

describe("pickText", () => {
  it("按当前语言取文案，缺失时依次回退英文、中文、高棉文", () => {
    expect(pickText({ zh: "半程", en: "Half", km: "ពាក់កណ្ដាល" }, "km")).toBe("ពាក់កណ្ដាល");
    expect(pickText({ zh: "半程", en: "Half" }, "km")).toBe("Half");
    expect(pickText({ zh: "半程" }, "en")).toBe("半程");
    expect(pickText({ km: "ពាក់កណ្ដាល" }, "zh")).toBe("ពាក់កណ្ដាល");
    expect(pickText({}, "zh")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("输出包含年份与 24 小时制分钟", () => {
    const text = formatDateTime("2026-09-14T03:30:00Z", "en");
    expect(text).toContain("2026");
    expect(text).toMatch(/\d{2}:30/);
  });
});
