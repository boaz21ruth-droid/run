import { LANGS, LANG_LABELS, setLanguage, useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import styles from "./LanguageSwitch.module.css";

export function LanguageSwitch() {
  const { t } = useTranslation("common");
  const active = useLang();

  return (
    <div className={styles.switch} role="group" aria-label={t("lang.label")}>
      {LANGS.map((lang) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          data-testid={`lang-switch-${lang}`}
          aria-pressed={lang === active}
          className={lang === active ? `${styles.option} ${styles.on}` : styles.option}
          onClick={() => void setLanguage(lang)}
        >
          {LANG_LABELS[lang]}
        </button>
      ))}
    </div>
  );
}
