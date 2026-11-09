import { useTranslation } from "react-i18next";
import { timezoneLabel } from "./eventTime";

/** 放在日期时间输入框旁（Form.Item extra）的时区说明，例如“时区：Asia/Phnom_Penh (UTC+7)” */
export function TimezoneHint({ tz, prefix }: { tz: string; prefix?: string }) {
  const { t } = useTranslation("admin");
  const zone = t("time.zone", { zone: timezoneLabel(tz) });
  return <span data-testid="timezone-hint">{prefix ? `${prefix} · ${zone}` : zone}</span>;
}
