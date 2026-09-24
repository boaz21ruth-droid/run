import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { isBrowserMode } from "../auth/session";
import { Footer } from "./Footer";
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
          <UserMenu />
          <LanguageSwitch />
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

/** 未登录（浏览器模式）时显示登录入口，已登录时显示显示名/手机号，链接到「我的」账号页 */
function UserMenu() {
  const { status, user } = useAuth();
  const { t } = useTranslation("user");
  if (status === "authenticated" && user) {
    return (
      <NavLink to="/me" className={styles.userLink} data-testid="nav-me">
        {user.displayName || user.phoneMasked || t("me.nav")}
      </NavLink>
    );
  }
  if (status === "unauthenticated" && isBrowserMode()) {
    return (
      <NavLink to="/login" className={styles.userLink} data-testid="nav-login">
        {t("auth.login")}
      </NavLink>
    );
  }
  return null;
}
