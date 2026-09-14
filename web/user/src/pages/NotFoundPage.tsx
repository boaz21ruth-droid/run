import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import styles from "./Page.module.css";

export function NotFoundPage() {
  const { t } = useTranslation("user");
  return (
    <section>
      <h1 className={styles.title}>{t("notFound.title")}</h1>
      <p className={styles.muted}>{t("notFound.body")}</p>
      <Link to="/" className={styles.more}>
        {t("notFound.home")}
      </Link>
    </section>
  );
}
