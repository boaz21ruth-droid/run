import { useLang, type Lang } from "@werun/i18n";
import { brand } from "@werun/tokens";
import { App as AntdApp, ConfigProvider, type ConfigProviderProps } from "antd";
import enUS from "antd/locale/en_US";
import kmKH from "antd/locale/km_KH";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/km";
import "dayjs/locale/zh-cn";
import { useEffect, type ReactNode } from "react";

type AntdLocale = NonNullable<ConfigProviderProps["locale"]>;

const ANTD_LOCALES: Record<Lang, AntdLocale> = { zh: zhCN, en: enUS, km: kmKH };
const DAYJS_LOCALES: Record<Lang, string> = { zh: "zh-cn", en: "en", km: "km" };

export function AntdProvider({ children }: { children: ReactNode }) {
  const lang = useLang();

  useEffect(() => {
    dayjs.locale(DAYJS_LOCALES[lang]);
  }, [lang]);

  return (
    <ConfigProvider
      locale={ANTD_LOCALES[lang]}
      theme={{
        token: {
          colorPrimary: brand.primary,
          colorLink: brand.primary,
          borderRadius: 10,
          fontFamily: "var(--sans)",
        },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}
