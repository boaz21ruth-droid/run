import type { Schemas } from "@werun/api-client";
import { Alert, Button, Card, Form, Input, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useLogin } from "../auth/useMe";
import { LanguageSwitch } from "../layout/LanguageSwitch";

export function LoginPage() {
  const { t } = useTranslation("admin");
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/events";
  const required = [{ required: true, message: t("form.required") }];

  const onFinish = (values: Schemas["LoginRequest"]) => {
    login.mutate(values, {
      onSuccess: () => void navigate(from, { replace: true }),
    });
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--paper)" }}>
      <Card style={{ width: "100%", maxWidth: 380 }}>
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t("login.title")}
            </Typography.Title>
            <LanguageSwitch />
          </Space>
          {login.error ? <Alert type="error" showIcon message={login.error.message} /> : null}
          <Form<Schemas["LoginRequest"]>
            name="login"
            layout="vertical"
            requiredMark={false}
            onFinish={onFinish}
            disabled={login.isPending}
          >
            <Form.Item name="username" label={t("login.username")} rules={required}>
              <Input autoComplete="username" data-testid="login-username" />
            </Form.Item>
            <Form.Item name="password" label={t("login.password")} rules={required}>
              <Input.Password autoComplete="current-password" data-testid="login-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={login.isPending} data-testid="login-submit">
              {t("login.submit")}
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
