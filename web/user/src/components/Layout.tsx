import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet } from "react-router";
import styles from "./Layout.module.css";
import { LanguageSwitch } from "./LanguageSwitch";

export function Layout() {
  const { t } = useTranslation("user");
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.navLink} ${styles.active}` : styles.navLink);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link to="/" className={styles.brand}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmark}>{t("common:brand.name")}</span>
          </Link>
          <nav className={styles.nav}>
            <NavLink to="/" end className={navClass}>
              {t("common:nav.home")}
            </NavLink>
            <NavLink to="/events" className={navClass}>
              {t("common:nav.events")}
            </NavLink>
            <NavLink to="/orders" className={navClass}>
              {t("orders.nav")}
            </NavLink>
            <NavLink to="/profiles" className={navClass}>
              {t("profiles.nav")}
            </NavLink>
          </nav>
          <LanguageSwitch />
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
