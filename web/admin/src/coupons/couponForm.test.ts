import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { earlyCoupon } from "../test/fixtures";
import {
  emptyCoupon,
  formatDiscount,
  fromCoupon,
  parseDiscountValue,
  toCreateCouponRequest,
  toUpdateCouponRequest,
} from "./couponForm";

describe("parseDiscountValue", () => {
  it.each([
    ["PERCENT", "20", 20],
    ["PERCENT", " 100 ", 100],
    ["PERCENT", "0", null],
    ["PERCENT", "101", null],
    ["PERCENT", "12.5", null],
    ["AMOUNT", "5", 500],
    ["AMOUNT", "5.25", 525],
    ["AMOUNT", "0", null],
    ["AMOUNT", "abc", null],
    ["WAIVER", undefined, 0],
    ["WAIVER", "99", 0],
  ] as const)("%s %j → %j", (type, input, expected) => {
    expect(parseDiscountValue(type, input)).toBe(expected);
  });
});

describe("请求体转换", () => {
  it("新建：代码去空格转大写，固定金额按美元转分", () => {
    const body = toCreateCouponRequest(
      {
        ...emptyCoupon(),
        code: " run_kh ",
        discountType: "AMOUNT",
        discountValue: "5.5",
        quota: 10,
        validFrom: dayjs("2026-09-20T01:00:00Z"),
      },
      7,
    );

    expect(body).toEqual({
      code: "RUN_KH",
      eventId: 7,
      discountType: "AMOUNT",
      discountValue: 550,
      quota: 10,
      minRunners: null,
      validFrom: "2026-09-20T01:00:00.000Z",
      validUntil: null,
      status: "ACTIVE",
    });
  });

  it("修改：请求体不含代码，免单值为 0", () => {
    const body = toUpdateCouponRequest({ ...fromCoupon(earlyCoupon), discountType: "WAIVER", discountValue: "" }, 7);

    expect(body).not.toHaveProperty("code");
    expect(body).toMatchObject({ eventId: 7, discountType: "WAIVER", discountValue: 0, quota: 50, minRunners: 2 });
  });

  it("折扣值非法时抛错（表单校验保证不会走到这里）", () => {
    expect(() => toCreateCouponRequest({ ...emptyCoupon(), code: "ABC", discountValue: "0", quota: 1 }, 7)).toThrow(
      "invalid discount",
    );
  });

  it("fromCoupon 回填与 formatDiscount 展示", () => {
    expect(fromCoupon(earlyCoupon)).toMatchObject({ code: "EARLY_2026", discountValue: "20", quota: 50, minRunners: 2 });
    expect(fromCoupon({ ...earlyCoupon, discountType: "AMOUNT", discountValue: 500 }).discountValue).toBe("5.00");
    expect(formatDiscount(earlyCoupon, "Free")).toBe("20%");
    expect(formatDiscount({ discountType: "AMOUNT", discountValue: 250 }, "Free")).toBe("$2.50");
    expect(formatDiscount({ discountType: "WAIVER", discountValue: 0 }, "Free")).toBe("Free");
  });
});
