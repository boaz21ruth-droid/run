import { ApiError } from "@werun/api-client";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import styles from "./LoginPage.module.css";
import pageStyles from "./Page.module.css";

const COUNTRY_CODES = ["+855", "+86", "+65", "+66", "+84", "+1", "+44", "+61"];

/**
 * 只接受同源相对路径，避免用 next 参数跳到外部站点。
 * 除了排除 "//" 开头的协议相对地址，还要拒绝反斜杠：浏览器的 URL 解析（history.pushState /
 * react-router 用的就是它）对特殊 scheme 会把 "\" 当 "/" 处理，"/\\evil.com" 看起来像同源路径，
 * 实际解析出来 host 是 evil.com。用 new URL() 相对 origin 解析后比对 origin 兜底。
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  try {
    const resolved = new URL(raw, window.location.origin);
    if (resolved.origin !== window.location.origin) {
      return "/";
    }
    // next 指回登录页本身会在登录成功后原地打转，退回首页
    return resolved.pathname === "/login" ? "/" : raw;
  } catch {
    return "/";
  }
}

export function LoginPage() {
  const { t } = useTranslation("user");
  const { status, requestCode, loginWithPhone } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const [countryCode, setCountryCode] = useState("+855");
  const [local, setLocal] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [resendIn]);

  if (status === "authenticated") {
    return <Navigate to={next} replace />;
  }

  // 去掉非数字与本地号码前导 0，再拼国家码
  const phone = countryCode + local.replace(/\D/g, "").replace(/^0+/, "");

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await requestCode(phone);
      setSentTo(phone);
      setResendIn(res.resendAfterSeconds);
      setCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.phone.sendFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithPhone(sentTo ?? phone, code);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.phone.verifyFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card}>
      <h1 className={pageStyles.title}>{t("auth.phone.title")}</h1>
      <p className={pageStyles.muted}>{t("auth.phone.intro")}</p>
      {sentTo === null ? (
        <form onSubmit={send} className={styles.form}>
          <label className={styles.row}>
            <span>{t("auth.phone.countryCode")}</span>
            <input
              list="country-codes"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value.trim())}
              data-testid="login-country"
            />
            <datalist id="country-codes">
              {COUNTRY_CODES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className={styles.row}>
            <span>{t("auth.phone.number")}</span>
            <input
              inputMode="tel"
              autoComplete="tel-national"
              placeholder={t("auth.phone.numberPlaceholder")}
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              data-testid="login-phone"
            />
          </label>
          <button type="submit" disabled={busy || local.replace(/\D/g, "").length < 6} data-testid="login-send">
            {busy ? t("auth.phone.sending") : t("auth.phone.sendCode")}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className={styles.form}>
          <p role="status">{t("auth.phone.sentTo", { phone: sentTo })}</p>
          <label className={styles.row}>
            <span>{t("auth.phone.code")}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              data-testid="login-code"
            />
            <small>{t("auth.phone.codeHint")}</small>
          </label>
          <button type="submit" disabled={busy || code.length !== 6} data-testid="login-verify">
            {busy ? t("auth.phone.verifying") : t("auth.phone.verify")}
          </button>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.resend}
              onClick={() => void send()}
              disabled={busy || resendIn > 0}
              data-testid="login-resend"
            >
              {resendIn > 0 ? t("auth.phone.resendIn", { seconds: resendIn }) : t("auth.phone.resend")}
            </button>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                setSentTo(null);
                setError(null);
              }}
            >
              {t("auth.phone.changeNumber")}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <p className={pageStyles.muted}>{t("auth.phone.orTelegram")}</p>
    </section>
  );
}
