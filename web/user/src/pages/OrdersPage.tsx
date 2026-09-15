import { formatUsd } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatDateTime, pickText } from "../format";
import { useMyOrders } from "../orders/api";
import orders from "../orders/Orders.module.css";
import styles from "./Page.module.css";

export function OrdersPage() {
  const { t } = useTranslation("user");
  const lang = useLang();
  const query = useMyOrders();

  return (
    <section>
      <h1 className={styles.title}>{t("orders.title")}</h1>
      <QueryState query={query}>
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted} data-testid="orders-empty">
              {t("orders.empty")}
            </p>
          ) : (
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
          )
        }
      </QueryState>
    </section>
  );
}
