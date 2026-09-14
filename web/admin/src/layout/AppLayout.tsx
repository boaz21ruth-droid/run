import { CalendarOutlined, LogoutOutlined, WalletOutlined } from "@ant-design/icons";
import { Button, Layout, Menu, Space, Tag, Typography, type MenuProps } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import { PERM_EVENT_CONFIG, PERM_PAYMENT_ACCOUNT_MANAGE, can, type Access } from "../auth/can";
import { useLogout, useMe } from "../auth/useMe";
import { LanguageSwitch } from "./LanguageSwitch";

interface MenuEntry {
  key: string;
  labelKey: string;
  permission: string;
  access: Access;
  icon: ReactNode;
}

/** 菜单项声明所需权限；没有权限的菜单项不渲染 */
const MENU: MenuEntry[] = [
  { key: "/events", labelKey: "events.title", permission: PERM_EVENT_CONFIG, access: "read", icon: <CalendarOutlined /> },
  {
    key: "/payment-accounts",
    labelKey: "paymentAccounts.title",
    permission: PERM_PAYMENT_ACCOUNT_MANAGE,
    access: "read",
    icon: <WalletOutlined />,
  },
];

export function AppLayout() {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  const visible = MENU.filter((entry) => can(me?.permissions, entry.permission, entry.access));
  const items: MenuProps["items"] = visible.map((entry) => ({
    key: entry.key,
    icon: entry.icon,
    label: t(entry.labelKey),
  }));
  const selected = visible.find((entry) => location.pathname.startsWith(entry.key))?.key;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0} theme="light" width={220}>
        <div style={{ padding: "16px 20px", fontWeight: 800, fontSize: 18 }}>{t("common:brand.name")}</div>
        <Menu
          mode="inline"
          items={items}
          selectedKeys={selected ? [selected] : []}
          onClick={({ key }) => void navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 16,
            paddingInline: 24,
            background: "var(--card)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <LanguageSwitch />
          {me ? (
            <Space>
              <Typography.Text strong>{me.staff.fullName}</Typography.Text>
              <Tag color="blue">{t(`role.${me.staff.role}`)}</Tag>
            </Space>
          ) : null}
          <Button
            icon={<LogoutOutlined />}
            loading={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSettled: () => void navigate("/login", { replace: true }) })}
          >
            {t("layout.logout")}
          </Button>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
