import { ApiError, unwrap, type Schemas } from "@werun/api-client";
import { setLanguage } from "@werun/i18n";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useApi } from "../api";
import { useAuth } from "../auth/AuthProvider";
import styles from "./MePage.module.css";
import pageStyles from "./Page.module.css";

type Locale = Schemas["AppUser"]["locale"];

const LOCALE_LABELS: Record<Locale, string> = { zh: "中文", en: "English", km: "ខ្មែរ" };
const LOCALES: Locale[] = ["zh", "en", "km"];

/** 顶栏「我的」链接指向的账号页：改显示名/语言、看手机号与 Telegram 绑定、退出登录 */
export function MePage() {
  const { t } = useTranslation("user");
  const api = useApi();
  const navigate = useNavigate();
  const { user, logout, setUser } = useAuth();
  // RequireRunner 只在 authenticated 时渲染子路由，这里 user 一定存在；类型仍是可空的所以兜底一下
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [locale, setLocale] = useState<Locale>(user?.locale ?? "en");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    return null;
  }

  const changeLocale = (next: Locale) => {
    setLocale(next);
    setSaved(false);
    void setLanguage(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = unwrap(await api.PATCH("/app/me", { body: { displayName, locale } }));
      setUser(updated);
      setDisplayName(updated.displayName);
      setLocale(updated.locale);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("profiles.errors.save"));
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    void logout().then(() => navigate("/"));
  };

  return (
    <section className={styles.card}>
      <h1 className={pageStyles.title}>{t("me.title")}</h1>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label className={styles.row}>
          <span>{t("me.displayName")}</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} data-testid="me-display-name" />
          <small>{t("me.displayNameHint")}</small>
        </label>
        <label className={styles.row}>
          <span>{t("me.locale")}</span>
          <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)} data-testid="me-locale">
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_LABELS[code]}
              </option>
            ))}
          </select>
        </label>
        {user.phoneMasked && (
          <div className={styles.info}>
            <span>{t("me.phone")}</span>
            <span>{user.phoneMasked}</span>
          </div>
        )}
        {user.telegramUsername && (
          <div className={styles.info}>
            <span>{t("me.telegram")}</span>
            <span>@{user.telegramUsername}</span>
          </div>
        )}
        <div className={styles.actions}>
          <button type="submit" className={styles.save} disabled={saving} data-testid="me-save">
            {saving ? t("me.saving") : t("me.save")}
          </button>
          {saved && (
            <p role="status" className={styles.status}>
              {t("me.saved")}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </form>
      <button type="button" className={styles.logout} onClick={handleLogout} data-testid="me-logout">
        {t("me.logout")}
      </button>
    </section>
  );
}
