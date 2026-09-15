import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { TicketQr } from "../components/TicketQr";
import { formatDateTime, pickText } from "../format";
import styles from "./Orders.module.css";

/** 订单详情里按状态显示的说明与操作；待付款不显示（由 OrderDetailPage 自己渲染倒计时与去付款按钮） */
export function OrderStatePanel({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();

  switch (order.status) {
    case "PROOF_SUBMITTED":
      return (
        <section className={styles.notice}>
          <p data-testid="order-reviewing">{t("orders.panel.reviewing")}</p>
        </section>
      );
    case "PROOF_REJECTED":
      return (
        <section className={styles.rejectBox}>
          <h2 className={styles.sectionTitle}>{t("orders.panel.rejectedTitle")}</h2>
          <div data-testid="order-reject-reason">
            {order.lastRejection ? (
              <>
                <p>
                  <strong>{t(`orders.rejectCode.${order.lastRejection.code}`)}</strong>
                </p>
                {order.lastRejection.reason ? (
                  <p>{t("orders.panel.rejectReason", { reason: order.lastRejection.reason })}</p>
                ) : null}
              </>
            ) : null}
            {order.deadlineAt ? <p>{t("orders.panel.reuploadBy", { deadline: formatDateTime(order.deadlineAt, lang) })}</p> : null}
          </div>
          <Link to={`/orders/${order.orderNo}/proof`} data-testid="order-reupload" className={styles.primary}>
            {t("orders.panel.reupload")}
          </Link>
        </section>
      );
    case "PAID":
      return (
        <section className={styles.section}>
          <p>{t("orders.panel.paid")}</p>
          <ul className={styles.ticketList}>
            {order.participants.map((participant) =>
              participant.ticketCode ? (
                <li key={participant.regNo} className={styles.ticket}>
                  <div>
                    <strong>{participant.fullName}</strong>
                    <p className={styles.help}>
                      {pickText(participant.categoryName, lang)} · {participant.regNo}
                    </p>
                  </div>
                  <TicketQr code={participant.ticketCode} label={t("orders.panel.ticketAlt", { name: participant.fullName })} />
                </li>
              ) : null,
            )}
          </ul>
        </section>
      );
    case "EXPIRED":
      return (
        <section className={styles.notice}>
          <p>{t("orders.panel.expired")}</p>
          <Link to={`/events/${order.eventSlug}/register`} data-testid="order-register-again" className={styles.primary}>
            {t("orders.panel.registerAgain")}
          </Link>
        </section>
      );
    case "CANCELLED":
      return (
        <section className={styles.notice}>
          <p>{t("orders.panel.cancelled")}</p>
        </section>
      );
    default:
      return null;
  }
}
