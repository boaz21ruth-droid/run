import type { Schemas } from "@werun/api-client";
import { useTranslation } from "react-i18next";
import styles from "./Rules.module.css";

type RefundPolicy = Schemas["RefundPolicy"];

interface Row {
  key: string;
  when: string;
  what: string;
}

/** 把退改政策展开成「开赛 14 天前 · 退 80%」这样的行；最后一档之后是「不退」 */
export function refundRows(policy: RefundPolicy, t: (key: string, params?: Record<string, unknown>) => string): Row[] {
  const rows: Row[] = [];
  policy.tiers.forEach((tier, i) => {
    const upper = i > 0 ? policy.tiers[i - 1]?.days : undefined;
    rows.push({
      key: `tier-${i}`,
      when: upper === undefined ? t("rules.refund.before", { days: tier.days }) : t("rules.refund.between", { from: tier.days, to: upper }),
      what: tier.percent > 0 ? t("rules.refund.percent", { percent: tier.percent }) : t("rules.refund.none"),
    });
  });
  const last = policy.tiers.at(-1);
  if (!last || last.days > 0) {
    rows.push({
      key: "rest",
      when: last ? t("rules.refund.within", { days: last.days }) : t("rules.refund.any"),
      what: t("rules.refund.none"),
    });
  }
  rows.push({
    key: "transfer",
    when: t("rules.refund.transfer"),
    what: policy.transferDays === null ? t("rules.refund.noTransfer") : t("rules.refund.transferUntil", { days: policy.transferDays }),
  });
  return rows;
}

/** 主办方设置的退改政策（设计稿第 04 屏）。只展示，退款仍由客服与财务按流程办理 */
export function RefundPolicyCard({ policy }: { policy: RefundPolicy }) {
  const { t } = useTranslation("user");
  return (
    <section className={styles.card} data-testid="refund-policy">
      <div className={styles.head}>
        <h2 className={styles.title}>{t("rules.refund.title")}</h2>
        <span className={styles.badge}>{t("rules.refund.byOrganizer")}</span>
      </div>
      <dl className={styles.rows}>
        {refundRows(policy, t).map((row) => (
          <div key={row.key} className={styles.row}>
            <dt>{row.when}</dt>
            <dd>{row.what}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.note}>{t("rules.refund.howTo")}</p>
    </section>
  );
}
