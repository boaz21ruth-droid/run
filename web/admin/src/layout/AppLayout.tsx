import { LogoutOutlined } from "@ant-design/icons";
import { Button, Layout, Menu, Space, Tag, Typography, type MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useLogout, useMe } from "../auth/useMe";
import { LanguageSwitch } from "./LanguageSwitch";
import { visibleMenu } from "./menu";

export function AppLayout() {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  const visible = visibleMenu(me?.permissions);
  const items: MenuProps["items"] = visible.map((entry) => ({
    key: entry.key,
    icon: entry.icon,
    label: t(entry.labelKey),
  }));
  const selected = visible.find((entry) => location.pathname.startsWith(entry.key))?.key;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider
        breakpoint="lg"
        collapsedWidth={0}
        theme="light"
        width={220}
        // 手机上菜单收起：把展开按钮放进顶栏那一行，不压住内容
        zeroWidthTriggerStyle={{ top: 12 }}
      >
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
            gap: "8px 16px",
            // 手机上顶栏会折行：高度随内容，不用 antd 默认的固定 64px
            height: "auto",
            minHeight: 64,
            lineHeight: "normal",
            paddingBlock: 12,
            paddingInline: "56px 24px",
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
        <Layout.Content style={{ padding: "24px clamp(12px, 4vw, 24px)" }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
