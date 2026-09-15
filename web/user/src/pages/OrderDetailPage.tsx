import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatDateTime, pickText } from "../format";
import { useCancelOrder, useMyOrder } from "../orders/api";
import orders from "../orders/Orders.module.css";
import { OrderStatePanel } from "../orders/OrderStatePanel";
import { formatCountdown, useCountdown } from "../pay/useCountdown";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

export function OrderDetailPage() {
  const { orderNo = "" } = useParams();
  const order = useMyOrder(orderNo);

  if (order.error instanceof ApiError && order.error.status === 404) {
    return <NotFoundPage />;
  }
  return <QueryState query={order}>{(data) => <OrderDetailView order={data} />}</QueryState>;
}

// 审核中、驳回原因与重传、已确认参赛凭证、已过期、已取消的说明由 OrderStatePanel 渲染
function OrderDetailView({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const cancel = useCancelOrder(order.orderNo);
  const [confirming, setConfirming] = useState(false);

  // discountCents = 优惠码减免 + 识别分
  const couponDiscount = order.discountCents - order.identOffsetCents;
  const canPay = order.status === "PENDING_PAYMENT" || order.status === "PROOF_REJECTED";
  const canCancel = order.status === "PENDING_PAYMENT";
  const remaining = useCountdown(canPay ? order.deadlineAt : null);

  return (
    <article>
      <p className={styles.muted}>{pickText(order.eventName, lang)}</p>
      <h1 className={styles.title}>{t("orders.detailTitle", { orderNo: order.orderNo })}</h1>
      <p className={orders.statusLine}>
        <span className={orders.badge} data-testid="order-status" data-status={order.status}>
          {t(`orders.status.${order.status}`)}
        </span>
        {canPay && order.deadlineAt ? (
          <span data-testid="order-deadline">{t("orders.deadline", { time: formatDateTime(order.deadlineAt, lang) })}</span>
        ) : null}
        {canPay && remaining !== null ? (
          <span data-testid="order-countdown" aria-label={t("pay.countdown")}>
            {formatCountdown(remaining)}
          </span>
        ) : null}
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t("orders.table.name")}</th>
              <th scope="col">{t("orders.table.category")}</th>
              <th scope="col">{t("orders.table.listPrice")}</th>
              <th scope="col">{t("orders.table.paid")}</th>
              <th scope="col">{t("orders.table.registration")}</th>
            </tr>
          </thead>
          <tbody>
            {order.participants.map((p) => (
              <tr key={p.regNo}>
                <th scope="row">{p.fullName}</th>
                <td>{pickText(p.categoryName, lang)}</td>
                <td className={styles.num}>{formatUsd(p.listPriceCents)}</td>
                <td className={styles.num}>{formatUsd(p.paidCents)}</td>
                <td>{t(`orders.regStatus.${p.registrationStatus}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className={orders.amounts}>
        <div className={orders.amountRow}>
          <dt>{t("orders.amount.list")}</dt>
          <dd data-testid="order-list-amount">{formatUsd(order.listAmountCents)}</dd>
        </div>
        {couponDiscount > 0 ? (
          <div className={orders.amountRow}>
            <dt>{t("orders.amount.coupon")}</dt>
            <dd data-testid="order-coupon-discount">{formatUsd(-couponDiscount)}</dd>
          </div>
        ) : null}
        {order.identOffsetCents > 0 ? (
          <div className={orders.amountRow}>
            <dt>
              {t("orders.amount.ident")}
              <span className={orders.hint}> · {t("orders.amount.identHint")}</span>
            </dt>
            <dd data-testid="order-ident-offset">{formatUsd(-order.identOffsetCents)}</dd>
          </div>
        ) : null}
        <div className={orders.total}>
          <dt>{t("orders.amount.total")}</dt>
          <dd data-testid="order-amount">{formatUsd(order.amountCents)}</dd>
        </div>
      </dl>

      <OrderStatePanel order={order} />

      {cancel.error ? (
        <p className={orders.error} role="alert" data-testid="form-error">
          {cancel.error instanceof ApiError ? cancel.error.message : t("common:state.error")}
        </p>
      ) : null}

      <div className={orders.actions}>
        {canPay ? (
          <Link to={`/orders/${order.orderNo}/pay`} className={orders.primary} data-testid="order-pay">
            {t("orders.pay")}
          </Link>
        ) : null}
        {canCancel && !confirming ? (
          <button type="button" className={orders.secondary} data-testid="order-cancel" onClick={() => setConfirming(true)}>
            {t("orders.cancel")}
          </button>
        ) : null}
        {canCancel && confirming ? (
          <div className={orders.confirm} role="group">
            <p>{t("orders.cancelAsk")}</p>
            <div className={orders.actions}>
              <button
                type="button"
                className={orders.primary}
                data-testid="order-cancel-confirm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                {t("orders.cancelConfirm")}
              </button>
              <button type="button" className={orders.secondary} data-testid="order-cancel-keep" onClick={() => setConfirming(false)}>
                {t("orders.cancelKeep")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
