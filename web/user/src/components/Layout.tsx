import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useMatches } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { isBrowserMode } from "../auth/session";
import { Footer } from "./Footer";
import styles from "./Layout.module.css";
import { LanguageSwitch } from "./LanguageSwitch";

/** 路由 handle：title 为 i18n key（带命名空间），用于 document.title */
export interface RouteHandle {
  title?: string;
}

/** 顶栏（≥1024px）与底部标签栏（<1024px）共用的目的地 */
const DESTINATIONS = [
  { to: "/", end: true, label: "common:nav.home", tab: "nav.tabs.home", icon: <HomeIcon />, testId: "home" },
  { to: "/events", end: false, label: "common:nav.events", tab: "nav.tabs.events", icon: <FlagIcon />, testId: "events" },
  { to: "/orders", end: false, label: "orders.nav", tab: "nav.tabs.orders", icon: <ReceiptIcon />, testId: "orders" },
  { to: "/profiles", end: false, label: "profiles.nav", tab: "nav.tabs.profiles", icon: <RunnersIcon />, testId: "profiles" },
] as const;

export function Layout() {
  const { t } = useTranslation("user");
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.navLink} ${styles.active}` : styles.navLink);
  const tabClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab);
  const mainRef = useRouteFocusAndTitle();

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link to="/" className={styles.brand}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmark}>{t("common:brand.name")}</span>
          </Link>
          <nav className={styles.nav} aria-label={t("nav.label")}>
            {DESTINATIONS.map((d) => (
              <NavLink key={d.to} to={d.to} end={d.end} className={navClass}>
                {t(d.label)}
              </NavLink>
            ))}
          </nav>
          <UserMenu />
          <LanguageSwitch />
        </div>
      </header>
      <main ref={mainRef} className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
      {/* 窄屏顶栏导航隐藏，由底部标签栏代替；CSS 保证两者同一时刻只显示一个 */}
      <nav className={styles.tabbar} aria-label={t("nav.label")} data-testid="tabbar">
        {DESTINATIONS.map((d) => (
          <NavLink key={d.to} to={d.to} end={d.end} className={tabClass} data-testid={`tab-${d.testId}`}>
            {d.icon}
            <span className={styles.tabLabel}>{t(d.tab)}</span>
          </NavLink>
        ))}
      </nav>
      <ScrollRestoration />
    </div>
  );
}

/**
 * 路由变化时：document.title 换成当前页的本地化标题；焦点移到 <main>，让读屏从新页面开头读起。
 * 首次进入不抢焦点；只看 pathname，同页查询参数变化（如报名步骤）不移焦点。
 */
function useRouteFocusAndTitle() {
  const { t } = useTranslation("user");
  const location = useLocation();
  const matches = useMatches();
  const mainRef = useRef<HTMLElement>(null);
  const lastPath = useRef<string | null>(null);

  let titleKey: string | undefined;
  for (const match of matches) {
    const handle = match.handle as RouteHandle | undefined;
    if (handle?.title) {
      titleKey = handle.title;
    }
  }
  const brand = t("common:brand.name");
  const title = titleKey ? `${t(titleKey)} · ${brand}` : brand;

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    const previous = lastPath.current;
    lastPath.current = location.pathname;
    if (previous === null || previous === location.pathname) {
      return;
    }
    // preventScroll：滚动位置交给 ScrollRestoration，聚焦本身不再让页面跳动
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  return mainRef;
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

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.tabIcon}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function HomeIcon() {
  return (
    <Icon>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9v11h14V9" />
      <path d="M10 20v-6h4v6" />
    </Icon>
  );
}

function FlagIcon() {
  return (
    <Icon>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </Icon>
  );
}

function ReceiptIcon() {
  return (
    <Icon>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </Icon>
  );
}

function RunnersIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5" />
      <path d="M15.5 5.2a3 3 0 0 1 0 5.6" />
      <path d="M17.5 14.8c1.8.7 3 2.5 3.5 5.2" />
    </Icon>
  );
}
