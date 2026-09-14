import { Result } from "antd";
import { useTranslation } from "react-i18next";

export function ForbiddenPage() {
  const { t } = useTranslation("admin");
  return (
    <div data-testid="forbidden-page">
      <Result status="403" title={t("forbidden.title")} subTitle={t("forbidden.body")} />
    </div>
  );
}
