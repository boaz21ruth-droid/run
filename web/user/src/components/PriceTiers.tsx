import { formatUsd } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { tierDeadline, type PriceTier } from "../events/tiers";
import { formatMonthDay, formatNumber } from "../format";
import styles from "./PriceTiers.module.css";

/** sale_ends_at 是开区间：结束于 11-07 00:00 的档，最后一天显示为 11-06 */
const lastSaleDay = (iso: string) => new Date(new Date(iso).getTime() - 1).toISOString();

/** 赛事页的价格档时间线：早鸟售罄 / 当前在售剩余 / 之后的档位，截止与库存都摆出来 */
export function PriceTiers({ tiers }: { tiers: readonly PriceTier[] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  if (tiers.length === 0) return null;
  const deadline = tierDeadline(tiers);

  const windowOf = (tier: PriceTier) => {
    const from = tier.saleStartsAt ? formatMonthDay(tier.saleStartsAt, lang) : null;
    const to = tier.saleEndsAt ? formatMonthDay(lastSaleDay(tier.saleEndsAt), lang) : null;
    if (from && to) return t("tiers.window", { from, to });
    if (to) return t("tiers.until", { date: to });
    if (from) return t("tiers.since", { date: from });
    return "";
  };

  const stateOf = (tier: PriceTier) => {
    if (tier.state === "ON_SALE") {
      return tier.remaining != null && tier.quota != null
        ? t("tiers.left", { n: formatNumber(tier.remaining, lang), quota: formatNumber(tier.quota, lang) })
        : t("tiers.state.ON_SALE");
    }
    return t(`tiers.state.${tier.state}`);
  };

  return (
    <section className={styles.section} aria-labelledby="tiers-title">
      <h2 id="tiers-title" className={styles.title}>
        {t("tiers.title")}
      </h2>
      <ul className={styles.list}>
        {tiers.map((tier) => (
          <li key={tier.id} className={styles.row} data-state={tier.state} data-testid={`tier-${tier.id}`}>
            <span className={styles.left}>
              <span className={styles.name}>{tier.name}</span>
              {tier.audience === "LOCAL" ? <span className={styles.local}>{t("tiers.local")}</span> : null}
              <span className={styles.window}>{windowOf(tier)}</span>
            </span>
            <span className={styles.right}>
              <span className={styles.state}>{stateOf(tier)}</span>
              <span className={styles.price}>{formatUsd(tier.priceCents)}</span>
            </span>
          </li>
        ))}
      </ul>
      {deadline?.next ? (
        <p className={styles.note} data-testid="tier-deadline">
          {t("tiers.deadline", {
            name: deadline.tier.name,
            count: deadline.daysLeft,
            price: formatUsd(deadline.next.priceCents),
          })}
        </p>
      ) : null}
    </section>
  );
}
