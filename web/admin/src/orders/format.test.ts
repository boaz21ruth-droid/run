import { describe, expect, it } from "vitest";
import { centsToUsdInput, rowProps, waitingParts } from "./format";

describe("centsToUsdInput", () => {
  it("整数分转成两位小数的美元字符串", () => {
    expect(centsToUsdInput(2451)).toBe("24.51");
    expect(centsToUsdInput(5)).toBe("0.05");
    expect(centsToUsdInput(100000)).toBe("1000.00");
  });
});

describe("waitingParts", () => {
  it("按分钟向下取整拆成小时与分钟，未来时间记为 0", () => {
    const now = Date.parse("2026-09-15T04:10:59Z");
    expect(waitingParts("2026-09-14T03:00:00Z", now)).toEqual({ hours: 25, minutes: 10 });
    expect(waitingParts("2026-09-15T04:02:00Z", now)).toEqual({ hours: 0, minutes: 8 });
    expect(waitingParts("2026-09-15T05:00:00Z", now)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe("rowProps", () => {
  it("在行属性上附加 data-testid 与 data-* 属性", () => {
    const onClick = () => undefined;
    expect(rowProps("proof-row-PF1", { onClick }, { "data-over-sla": "true" })).toEqual({
      onClick,
      "data-testid": "proof-row-PF1",
      "data-over-sla": "true",
    });
  });
});
