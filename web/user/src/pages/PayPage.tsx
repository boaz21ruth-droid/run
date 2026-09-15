import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { pickText } from "../format";
import { useMyOrder } from "../orders/api";
import orders from "../orders/Orders.module.css";
import { formatCountdown, useCountdown } from "../pay/useCountdown";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Pay.module.css";
import pageStyles from "./Page.module.css";

const PAYABLE_STATUSES = new Set<string>(["PENDING_PAYMENT", "PROOF_REJECTED"]);

export function PayPage() {
  const { orderNo = "" } = useParams();
  const order = useMyOrder(orderNo);

  if (order.error instanceof ApiError && order.error.status === 404) {
    return <NotFoundPage />;
  }
  return <QueryState query={order}>{(data) => <PayContent order={data} />}</QueryState>;
}

function PayContent({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const remaining = useCountdown(order.deadlineAt);
  const [copied, setCopied] = useState(false);

  if (!PAYABLE_STATUSES.has(order.status)) {
    return <Navigate to={`/orders/${order.orderNo}`} replace />;
  }

  const expired = remaining === 0;
  const copyOrderNo = async () => {
    try {
      await navigator.clipboard.writeText(order.orderNo);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={styles.panel}>
      <h1 className={pageStyles.title}>{t("pay.title")}</h1>
      <p className={pageStyles.muted}>{pickText(order.eventName, lang)}</p>

      <section className={styles.amount}>
        <span className={styles.label}>{t("pay.amount")}</span>
        <strong data-testid="pay-amount" className={styles.amountValue}>
          {formatUsd(order.amountCents)}
        </strong>
        <p className={styles.hint}>
          {order.identOffsetCents > 0 ? t("pay.amountHintIdent", { cents: order.identOffsetCents }) : t("pay.amountHint")}
        </p>
      </section>

      <div className={styles.qrWrap}>
        <img
          data-testid="pay-qr"
          className={styles.qr}
          src={`/api/files/${order.paymentAccount.qrFileId}`}
          alt={t("pay.qrAlt")}
          width={280}
          height={280}
        />
        <p className={pageStyles.muted}>{t("pay.scanQr")}</p>
      </div>

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t("pay.accountName")}</dt>
          <dd>{order.paymentAccount.accountName}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("pay.accountNo")}</dt>
          <dd className={styles.mono}>{order.paymentAccount.accountNoMasked}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("pay.orderNo")}</dt>
          <dd className={styles.orderNoCell}>
            <span data-testid="pay-order-no" className={styles.mono}>
              {order.orderNo}
            </span>
            <button type="button" data-testid="pay-copy-order-no" className={styles.copy} onClick={() => void copyOrderNo()}>
              {copied ? t("pay.copied") : t("pay.copy")}
            </button>
          </dd>
        </div>
      </dl>

      {expired ? (
        <p data-testid="pay-expired" className={styles.expired} role="alert">
          {t("pay.expired")}
        </p>
      ) : (
        <>
          {remaining !== null ? (
            <p className={styles.countdownRow}>
              <span>{t("pay.countdown")}</span>
              <strong data-testid="pay-countdown" className={styles.countdown}>
                {formatCountdown(remaining)}
              </strong>
            </p>
          ) : null}
          <Link to={`/orders/${order.orderNo}/proof`} data-testid="pay-upload-link" className={orders.primary}>
            {t("pay.upload")}
          </Link>
        </>
      )}

      <Link to={`/orders/${order.orderNo}`} className={orders.secondary}>
        {t("pay.backToOrder")}
      </Link>
    </article>
  );
}
