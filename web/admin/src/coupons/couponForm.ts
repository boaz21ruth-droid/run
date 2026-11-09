import { formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import type { Dayjs } from "dayjs";
import { fromEventWallClockOrNull, toEventWallClockOrNull } from "../time/eventTime";

type DiscountType = Schemas["DiscountType"];

export interface CouponFormValues {
  code: string;
  discountType: DiscountType;
  discountValue?: string;
  quota?: number | null;
  minRunners?: number | null;
  validFrom?: Dayjs | null;
  validUntil?: Dayjs | null;
  status: Schemas["CouponStatus"];
}

export function emptyCoupon(): CouponFormValues {
  return {
    code: "",
    discountType: "PERCENT",
    discountValue: "",
    quota: null,
    minRunners: null,
    validFrom: null,
    validUntil: null,
    status: "ACTIVE",
  };
}

/** 表单折扣值 → 接口值：PERCENT 为 1–100 的整数；AMOUNT 为美元字符串转分且大于 0；WAIVER 恒为 0。非法返回 null */
export function parseDiscountValue(type: DiscountType, input: string | undefined): number | null {
  if (type === "WAIVER") {
    return 0;
  }
  const text = (input ?? "").trim();
  if (type === "PERCENT") {
    if (!/^\d{1,3}$/.test(text)) {
      return null;
    }
    const percent = Number(text);
    return percent >= 1 && percent <= 100 ? percent : null;
  }
  const cents = parseUsdToCents(text);
  return cents !== null && cents > 0 ? cents : null;
}

/** 时间字段按赛事时区回填（tz 为赛事 timezone），见 time/eventTime.ts */
export function fromCoupon(coupon: Schemas["Coupon"], tz: string): CouponFormValues {
  let discountValue = "";
  if (coupon.discountType === "PERCENT") {
    discountValue = String(coupon.discountValue);
  } else if (coupon.discountType === "AMOUNT") {
    discountValue = formatUsd(coupon.discountValue).slice(1);
  }
  return {
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue,
    quota: coupon.quota,
    minRunners: coupon.minRunners,
    validFrom: toEventWallClockOrNull(coupon.validFrom, tz),
    validUntil: toEventWallClockOrNull(coupon.validUntil, tz),
    status: coupon.status,
  };
}

function commonFields(values: CouponFormValues, tz: string) {
  const discountValue = parseDiscountValue(values.discountType, values.discountValue);
  if (discountValue === null) {
    throw new Error(`invalid discount: ${values.discountValue ?? ""}`);
  }
  return {
    discountType: values.discountType,
    discountValue,
    quota: values.quota ?? 0,
    minRunners: values.minRunners ?? null,
    validFrom: fromEventWallClockOrNull(values.validFrom, tz),
    validUntil: fromEventWallClockOrNull(values.validUntil, tz),
    status: values.status,
  };
}

export function toCreateCouponRequest(values: CouponFormValues, eventId: number, tz: string): Schemas["CreateCouponRequest"] {
  return { code: values.code.trim().toUpperCase(), eventId, ...commonFields(values, tz) };
}

export function toUpdateCouponRequest(
  values: CouponFormValues,
  eventId: number | null,
  tz: string,
): Schemas["UpdateCouponRequest"] {
  return { eventId, ...commonFields(values, tz) };
}

export function formatDiscount(
  coupon: Pick<Schemas["Coupon"], "discountType" | "discountValue">,
  waiverLabel: string,
): string {
  switch (coupon.discountType) {
    case "PERCENT":
      return `${coupon.discountValue}%`;
    case "AMOUNT":
      return formatUsd(coupon.discountValue);
    default:
      return waiverLabel;
  }
}
