import { describe, expect, it } from "vitest";
import {
  PERM_COUPON_MANAGE,
  PERM_EVENT_CONFIG,
  PERM_EVENT_PUBLISH,
  PERM_ORDER_VIEW,
  PERM_PAYMENT_ACCOUNT_MANAGE,
  PERM_PRICE_CONFIG,
  PERM_PROOF_REVIEW,
  can,
  type Access,
  type PermissionMap,
} from "./can";

describe("can", () => {
  it.each<[PermissionMap | undefined, string, Access, boolean]>([
    [undefined, "event_config", "read", false],
    [{}, "event_config", "read", false],
    [{ event_config: "read" }, "event_config", "read", true],
    [{ event_config: "read" }, "event_config", "write", false],
    [{ event_config: "write" }, "event_config", "read", true],
    [{ event_config: "write" }, "event_config", "write", true],
  ])("permissions=%j 对 %s 要求 %s → %s", (permissions, permission, access, expected) => {
    expect(can(permissions, permission, access)).toBe(expected);
  });
});

describe("权限名常量与后端 iam.Perm* 一致", () => {
  it.each([
    [PERM_EVENT_CONFIG, "event_config"],
    [PERM_EVENT_PUBLISH, "event_publish"],
    [PERM_ORDER_VIEW, "order_view"],
    [PERM_PRICE_CONFIG, "price_config"],
    [PERM_COUPON_MANAGE, "coupon_manage"],
    [PERM_PAYMENT_ACCOUNT_MANAGE, "payment_account_manage"],
    [PERM_PROOF_REVIEW, "proof_review"],
  ])("%s", (constant, expected) => {
    expect(constant).toBe(expected);
  });
});
