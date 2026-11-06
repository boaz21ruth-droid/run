import { useQuery } from "@tanstack/react-query";
import { formatUsd, unwrap, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useApi } from "../api";
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
      <Notices />
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

/** 主办方群发的通知（最近几条）；取不到时不显示，不影响订单列表 */
function Notices() {
  const { t } = useTranslation("user");
  const lang = useLang();
  const api = useApi();
  const notices = useQuery({
    queryKey: ["notices"],
    queryFn: async () => unwrap(await api.GET("/app/notices")).items,
    retry: false,
  });
  const items = notices.data?.slice(0, 3) ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <section className={orders.notices} aria-labelledby="notices-title" data-testid="notices">
      <h2 id="notices-title" className={orders.sectionTitle}>
        {t("orders.notices")}
      </h2>
      <ul className={orders.noticeList}>
        {items.map((n) => (
          <li key={n.id} className={orders.notice}>
            <Link to={`/events/${n.eventSlug}`} className={orders.noticeEvent}>
              {n.eventName}
            </Link>
            <p className={orders.noticeBody}>{n.body}</p>
            <span className={orders.noticeTime}>{formatDateTime(n.createdAt, lang)}</span>
          </li>
        ))}
      </ul>
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
