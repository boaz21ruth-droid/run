import { AuditOutlined, CalendarOutlined, GiftOutlined, ProfileOutlined, TeamOutlined, WalletOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import {
  PERM_CONTENT_MANAGE,
  PERM_EVENT_CONFIG,
  PERM_ORDER_VIEW,
  PERM_PAYMENT_ACCOUNT_MANAGE,
  PERM_PROOF_REVIEW,
  PERM_RACEPACK_ISSUE,
  can,
  type Access,
  type PermissionMap,
} from "../auth/can";

export interface MenuEntry {
  key: string;
  labelKey: string;
  permission: string;
  access: Access;
  icon: ReactNode;
}

/** 菜单项声明所需权限；没有权限的菜单项不渲染。顺序也是登录后落地页的优先级 */
export const MENU: MenuEntry[] = [
  { key: "/events", labelKey: "events.title", permission: PERM_EVENT_CONFIG, access: "read", icon: <CalendarOutlined /> },
  {
    key: "/payment-accounts",
    labelKey: "paymentAccounts.title",
    permission: PERM_PAYMENT_ACCOUNT_MANAGE,
    access: "read",
    icon: <WalletOutlined />,
  },
  { key: "/proofs", labelKey: "proofs.title", permission: PERM_PROOF_REVIEW, access: "read", icon: <AuditOutlined /> },
  { key: "/orders", labelKey: "orders.title", permission: PERM_ORDER_VIEW, access: "read", icon: <ProfileOutlined /> },
  { key: "/racepack", labelKey: "racepack.title", permission: PERM_RACEPACK_ISSUE, access: "read", icon: <GiftOutlined /> },
  { key: "/community", labelKey: "community.title", permission: PERM_CONTENT_MANAGE, access: "read", icon: <TeamOutlined /> },
];

export function visibleMenu(permissions: PermissionMap | undefined): MenuEntry[] {
  return MENU.filter((entry) => can(permissions, entry.permission, entry.access));
}

/** 角色能访问的第一个菜单页；一个都没有时返回 null */
export function landingPath(permissions: PermissionMap | undefined): string | null {
  return visibleMenu(permissions)[0]?.key ?? null;
}
