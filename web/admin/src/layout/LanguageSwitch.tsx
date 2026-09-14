import { LANGS, LANG_LABELS, setLanguage, useLang } from "@werun/i18n";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

export function LanguageSwitch() {
  const active = useLang();
  const { t } = useTranslation("common");

  return (
    <div role="group" aria-label={t("lang.label")} style={{ display: "flex", gap: 4 }}>
      {LANGS.map((lang) => (
        <Button
          key={lang}
          size="small"
          lang={lang}
          type={lang === active ? "primary" : "default"}
          aria-pressed={lang === active}
          data-testid={`lang-switch-${lang}`}
          onClick={() => void setLanguage(lang)}
        >
          {LANG_LABELS[lang]}
        </Button>
      ))}
    </div>
  );
}
