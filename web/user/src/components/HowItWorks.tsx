import { useTranslation } from "react-i18next";
import styles from "./HowItWorks.module.css";

/** 报名流程是真实的三步顺序，所以这里用编号 */
export function HowItWorks() {
  const { t } = useTranslation("user");
  const steps = ["step1", "step2", "step3"] as const;

  return (
    <section className={styles.section} aria-labelledby="how-title">
      <h2 id="how-title" className={styles.title}>
        {t("home.how.title")}
      </h2>
      <ol className={styles.steps}>
        {steps.map((key, index) => (
          <li key={key} className={styles.step}>
            <span className={styles.number} aria-hidden="true">
              {index + 1}
            </span>
            <span className={styles.text}>{t(`home.how.${key}`)}</span>
          </li>
        ))}
      </ol>
      <p className={styles.note}>{t("home.how.note")}</p>
    </section>
  );
}
