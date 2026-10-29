import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ShareButton.module.css";

interface ShareTarget {
  url: string;
  title: string;
}

type ShareResult = "telegram" | "native" | "copied" | "failed";

/**
 * 分享顺序：Telegram 小程序里走 Telegram 分享面板；浏览器支持系统分享就用系统分享；
 * 都不行就复制链接。用户取消系统分享不算失败。
 */
export async function shareLink({ url, title }: ShareTarget): Promise<ShareResult> {
  const webApp = window.Telegram?.WebApp;
  if (webApp?.initData && webApp.openTelegramLink) {
    const params = new URLSearchParams({ url, text: title });
    webApp.openTelegramLink(`https://t.me/share/url?${params.toString()}`);
    return "telegram";
  }
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ url, title });
      return "native";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "native";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

export function ShareButton(target: ShareTarget) {
  const { t } = useTranslation("user");
  const [status, setStatus] = useState<"copied" | "failed" | null>(null);

  const onClick = async () => {
    const result = await shareLink(target);
    setStatus(result === "copied" || result === "failed" ? result : null);
  };

  return (
    <span className={styles.wrap}>
      <button type="button" className={styles.button} onClick={() => void onClick()} data-testid="share-button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
          <path d="M12 3v13" />
          <path d="m7 8 5-5 5 5" />
        </svg>
        {t("event.share")}
      </button>
      <span className={styles.status} role="status">
        {status ? t(`event.share_${status}`) : ""}
      </span>
    </span>
  );
}
