// 故意把测试进程时区设成与赛事时区不同的 Asia/Shanghai（UTC+8），证明换算不依赖浏览器 / 进程时区。
// 必须在任何 Date 计算之前设置；Node 在给 process.env.TZ 赋值时会立即刷新时区缓存。
process.env.TZ = "Asia/Shanghai";

import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { earlyBirdRule, earlyCoupon } from "../test/fixtures";
import { emptyCoupon, fromCoupon, toCreateCouponRequest, toUpdateCouponRequest } from "../coupons/couponForm";
import { toCreateEventRequest } from "../events/eventForm";
import { toRegistrationRequest, fromEventRegistration } from "../events/registrationForm";
import { emptyPriceRule, fromPriceRule, toPriceRuleInput } from "../pricing/priceRuleForm";
import {
  formatInTimezone,
  fromEventWallClock,
  timezoneLabel,
  toEventWallClock,
} from "./eventTime";

const PP = "Asia/Phnom_Penh";
/** DatePicker 里看到并输入的“墙上时间” */
const entered = () => dayjs("2026-11-15 06:00", "YYYY-MM-DD HH:mm");
const EXPECTED = "2026-11-14T23:00:00.000Z";

describe("测试进程时区", () => {
  it("确实是 Asia/Shanghai（UTC+8），不是赛事时区", () => {
    expect(new Date("2026-11-15T00:00:00Z").getTimezoneOffset()).toBe(-480);
  });
});

describe("eventTime", () => {
  it("赛事时区 2026-11-15 06:00 → 2026-11-14T23:00:00Z", () => {
    expect(fromEventWallClock(entered(), PP)).toBe(EXPECTED);
    expect(Date.parse(fromEventWallClock(entered(), PP))).toBe(Date.parse("2026-11-14T23:00:00Z"));
  });

  it("回填：UTC 时刻转成赛事时区墙上时间，往返不变", () => {
    const wall = toEventWallClock("2026-11-14T23:00:00Z", PP);
    expect(wall.format("YYYY-MM-DD HH:mm")).toBe("2026-11-15 06:00");
    expect(fromEventWallClock(wall, PP)).toBe(EXPECTED);
  });

  it("显示按赛事时区，时区标签带 UTC 偏移", () => {
    expect(formatInTimezone("2026-11-14T23:00:00Z", PP)).toBe("2026-11-15 06:00");
    expect(formatInTimezone(null, PP)).toBe("—");
    expect(timezoneLabel(PP)).toBe("Asia/Phnom_Penh (UTC+7)");
    expect(timezoneLabel("Asia/Kolkata")).toBe("Asia/Kolkata (UTC+5:30)");
    expect(timezoneLabel("America/New_York", "2026-01-15T00:00:00Z")).toBe("America/New_York (UTC-5)");
  });
});

describe("表单转换器按赛事时区序列化", () => {
  it("优惠码 validFrom / validUntil", () => {
    const values = { ...emptyCoupon(), code: "A", discountValue: "10", validFrom: entered(), validUntil: entered() };
    expect(toCreateCouponRequest(values, 7, PP)).toMatchObject({ validFrom: EXPECTED, validUntil: EXPECTED });
    expect(toUpdateCouponRequest(values, 7, PP)).toMatchObject({ validFrom: EXPECTED, validUntil: EXPECTED });
    const roundTrip = fromCoupon({ ...earlyCoupon, validFrom: "2026-11-14T23:00:00Z" }, PP);
    expect(roundTrip.validFrom?.format("YYYY-MM-DD HH:mm")).toBe("2026-11-15 06:00");
  });

  it("价格档 saleStartsAt / saleEndsAt", () => {
    const values = { ...emptyPriceRule([11]), priceUsd: "25", saleStartsAt: entered(), saleEndsAt: entered() };
    expect(toPriceRuleInput(values, PP)).toMatchObject({ saleStartsAt: EXPECTED, saleEndsAt: EXPECTED });
    const roundTrip = fromPriceRule({ ...earlyBirdRule, saleStartsAt: "2026-11-14T23:00:00Z" }, PP);
    expect(roundTrip.saleStartsAt?.format("YYYY-MM-DD HH:mm")).toBe("2026-11-15 06:00");
  });

  it("新建赛事组别 startAt（默认 Asia/Phnom_Penh）", () => {
    const request = toCreateEventRequest({
      slug: "x",
      eventType: "RACE",
      organizerType: "OFFICIAL",
      name: { zh: "a", en: "a", km: "a" },
      city: "c",
      raceDate: dayjs("2026-11-15"),
      categories: [{ code: "21K", name: { zh: "a", en: "a", km: "a" }, distanceM: 1, capacity: 1, startAt: entered() }],
    });
    expect(request.categories?.[0]?.startAt).toBe(EXPECTED);
  });

  it("报名开放时间 opensAt / closesAt", () => {
    expect(toRegistrationRequest({ open: true, opensAt: entered(), closesAt: null }, PP)).toEqual({
      open: true,
      opensAt: EXPECTED,
      closesAt: null,
    });
    const values = fromEventRegistration(
      { registrationOpen: false, registrationOpensAt: "2026-11-14T23:00:00Z", registrationClosesAt: null },
      PP,
    );
    expect(values.opensAt?.format("YYYY-MM-DD HH:mm")).toBe("2026-11-15 06:00");
    expect(values.closesAt).toBeNull();
  });
});
