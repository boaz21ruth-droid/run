import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useRouteError } from "react-router";
import styles from "./Page.module.css";

/**
 * 根路由的 errorElement：渲染或加载出错时代替整个布局显示，避免白屏。
 * i18n Provider 在路由器外层，这里照常可以取文案。
 */
export function RouteErrorPage({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const { t } = useTranslation("user");
  const error = useRouteError();

  useEffect(() => {
    console.error(error);
  }, [error]);

  useEffect(() => {
    document.title = `${t("routeError.title")} · ${t("common:brand.name")}`;
  }, [t]);

  return (
    <main className={styles.errorPage} data-testid="route-error">
      <h1 className={styles.title}>{t("routeError.title")}</h1>
      <p className={styles.muted}>{t("routeError.body")}</p>
      <div className={styles.errorActions}>
        <button type="button" className={styles.reload} onClick={reload} data-testid="route-error-reload">
          {t("routeError.reload")}
        </button>
        <Link to="/" className={styles.more}>
          {t("routeError.home")}
        </Link>
      </div>
    </main>
  );
}
