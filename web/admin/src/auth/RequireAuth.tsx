import { ApiError } from "@werun/api-client";
import { Button, Result, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation } from "react-router";
import { useMe } from "./useMe";

export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  const { t } = useTranslation("common");

  if (me.isPending) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <Spin />
      </div>
    );
  }

  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return (
      <Result
        status="error"
        title={t("state.error")}
        extra={<Button onClick={() => void me.refetch()}>{t("action.retry")}</Button>}
      />
    );
  }

  return <Outlet />;
}
