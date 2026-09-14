import type { Schemas } from "@werun/api-client";

export type Access = Schemas["Access"];
export type PermissionMap = Schemas["Me"]["permissions"];

export const PERM_EVENT_CONFIG = "event_config";
export const PERM_EVENT_PUBLISH = "event_publish";
export const PERM_ORDER_VIEW = "order_view";
export const PERM_PRICE_CONFIG = "price_config";
export const PERM_COUPON_MANAGE = "coupon_manage";
export const PERM_PAYMENT_ACCOUNT_MANAGE = "payment_account_manage";
export const PERM_PROOF_REVIEW = "proof_review";

/** 与后端 iam.Allowed 规则一致：要求读时，读或写权限都可以；要求写时，必须有写权限 */
export function can(permissions: PermissionMap | undefined, permission: string, access: Access): boolean {
  const granted = permissions?.[permission];
  if (granted === undefined) {
    return false;
  }
  return access === "read" || granted === "write";
}
