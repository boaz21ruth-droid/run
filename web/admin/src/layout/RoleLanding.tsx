import { Result } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { useMe } from "../auth/useMe";
import { landingPath } from "./menu";

/** 首页与未知地址：跳到当前角色能访问的第一个菜单页；一个都没有时给出友好提示，而不是 403 */
export function RoleLanding() {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const path = landingPath(me?.permissions);
  if (path) {
    return <Navigate to={path} replace />;
  }
  return (
    <div data-testid="no-pages">
      <Result
        status="info"
        title={t("landing.noPagesTitle")}
        subTitle={t("landing.noPagesBody", { role: me ? t(`role.${me.staff.role}`) : "" })}
      />
    </div>
  );
}
