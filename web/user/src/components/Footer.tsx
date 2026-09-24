import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { telegramBotLink } from "../auth/RequireRunner";
import styles from "./Footer.module.css";

export function Footer() {
  const { t } = useTranslation("user");
  const telegram = telegramBotLink();

  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div>
          <p className={styles.brand}>{t("common:brand.name")}</p>
          <p className={styles.tagline}>{t("footer.tagline")}</p>
        </div>
        <nav className={styles.links} aria-label={t("common:brand.name")}>
          <Link to="/events">{t("common:nav.events")}</Link>
          <Link to="/orders">{t("orders.nav")}</Link>
          {telegram ? (
            <a href={telegram} target="_blank" rel="noreferrer">
              {t("footer.bot")}
            </a>
          ) : null}
        </nav>
      </div>
    </footer>
  );
}
