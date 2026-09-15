import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import pageStyles from "../pages/Page.module.css";
import { useAuth } from "./AuthProvider";
import styles from "./RequireRunner.module.css";

/** 构建时注入的机器人用户名生成 t.me 链接；没有配置时返回 null */
export function telegramBotLink(username: string | undefined = import.meta.env.VITE_TELEGRAM_BOT_USERNAME): string | null {
  const name = username?.trim().replace(/^@/, "");
  return name ? `https://t.me/${encodeURIComponent(name)}` : null;
}

export function OpenInTelegram() {
  const { t } = useTranslation("user");
  const link = telegramBotLink();
  return (
    <section className={styles.card} data-testid="open-in-telegram">
      <h1 className={pageStyles.title}>{t("auth.openInTelegram.title")}</h1>
      <p className={styles.body}>{t("auth.openInTelegram.body")}</p>
      {link && (
        <a className={styles.action} href={link} target="_blank" rel="noreferrer">
          {t("auth.openInTelegram.action")}
        </a>
      )}
    </section>
  );
}

/** 需要跑者登录的页面包在里面；作为布局路由使用时渲染子路由。 */
export function RequireRunner({ children }: { children?: ReactNode }) {
  const { status } = useAuth();
  const { t } = useTranslation("user");

  if (status === "idle" || status === "loading") {
    return (
      <p className={pageStyles.muted} role="status">
        {t("auth.checking")}
      </p>
    );
  }
  if (status === "unauthenticated") {
    return <OpenInTelegram />;
  }
  return <>{children ?? <Outlet />}</>;
}
