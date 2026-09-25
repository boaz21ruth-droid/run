import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatDateTime, formatRaceDate, pickText } from "../format";
import { useMyFreeSignups, useMyOrders } from "../orders/api";
import orders from "../orders/Orders.module.css";
import styles from "./Page.module.css";

type OrderSummary = Schemas["OrderSummary"];
type FreeSignupSummary = Schemas["FreeSignupSummary"];

export function OrdersPage() {
  const { t } = useTranslation("user");
  const orderQuery = useMyOrders();
  const freeQuery = useMyFreeSignups();

  return (
    <section>
      <h1 className={styles.title}>{t("orders.title")}</h1>
      <QueryState query={orderQuery}>
        {(paid) => (
          <QueryState query={freeQuery}>
            {(free) =>
              paid.length === 0 && free.length === 0 ? (
                <p className={styles.muted} data-testid="orders-empty">
                  {t("orders.empty")}
                </p>
              ) : (
                <>
                  {paid.length > 0 ? <PaidOrders items={paid} showTitle={free.length > 0} /> : null}
                  {free.length > 0 ? <FreeSignups items={free} showTitle={paid.length > 0} /> : null}
                </>
              )
            }
          </QueryState>
        )}
      </QueryState>
    </section>
  );
}

function PaidOrders({ items, showTitle }: { items: OrderSummary[]; showTitle: boolean }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  return (
    <div className={orders.group}>
      {showTitle ? <h2 className={orders.sectionTitle}>{t("orders.paidSection")}</h2> : null}
      <ul className={orders.list}>
        {items.map((order) => (
          <li key={order.orderNo}>
            <Link to={`/orders/${order.orderNo}`} className={orders.item} data-testid={`order-item-${order.orderNo}`}>
              <span className={orders.itemHead}>
                <span className={orders.orderNo}>{order.orderNo}</span>
                <span className={orders.badge} data-status={order.status}>
                  {t(`orders.status.${order.status}`)}
                </span>
              </span>
              <span className={orders.eventName}>{pickText(order.eventName, lang)}</span>
              <span className={orders.itemMeta}>
                <span>{t("orders.participants", { n: order.participantCount })}</span>
                <span className={orders.money}>{formatUsd(order.amountCents)}</span>
              </span>
              <span className={orders.hint}>{formatDateTime(order.createdAt, lang)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FreeSignups({ items, showTitle }: { items: FreeSignupSummary[]; showTitle: boolean }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  return (
    <div className={orders.group}>
      {showTitle ? <h2 className={orders.sectionTitle}>{t("orders.freeSection")}</h2> : null}
      <ul className={orders.list}>
        {items.map((signup) => (
          <li key={signup.signupNo}>
            <Link
              to={`/events/${signup.eventSlug}`}
              className={orders.item}
              data-testid={`free-signup-item-${signup.signupNo}`}
            >
              <span className={orders.itemHead}>
                <span className={orders.orderNo}>{signup.signupNo}</span>
                <span className={orders.badge} data-status={signup.status}>
                  {t(`orders.freeStatus.${signup.status}`)}
                </span>
              </span>
              <span className={orders.eventName}>{pickText(signup.eventName, lang)}</span>
              <span className={orders.itemMeta}>
                <span>
                  {pickText(signup.categoryName, lang)} · {signup.fullName}
                </span>
                <span>{t("orders.freePrice")}</span>
              </span>
              <span className={orders.hint}>{t("orders.raceDate", { date: formatRaceDate(signup.raceDate, lang) })}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
