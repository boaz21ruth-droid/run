import { useTranslation } from "react-i18next";
import { distanceLabels, eventStatus, type EventStatus, type PublicEvent } from "../events/status";
import styles from "./EventCover.module.css";

const STATUS_CLASS: Record<EventStatus, string | undefined> = {
  open: styles.open,
  almostFull: styles.almostFull,
  soldOut: styles.soldOut,
  free: styles.free,
  closed: styles.closed,
  upcoming: styles.upcoming,
};

/**
 * 赛事封面。运营上传了照片就显示照片；没有时用赛事数据生成：
 * 深蓝渐变上排出组别距离，每场赛事天然不同，运营不用先准备图片。
 */
export function EventCover({ event, tall = false }: { event: PublicEvent; tall?: boolean }) {
  const { t } = useTranslation("user");
  const status = eventStatus(event);
  const labels = distanceLabels(event);

  return (
    <div className={tall ? `${styles.cover} ${styles.tall}` : styles.cover} data-testid="event-cover">
      {event.coverUrl ? (
        <img className={styles.photo} src={event.coverUrl} alt={t("event.coverAlt", { name: event.name })} loading="lazy" />
      ) : (
        <div className={styles.generated} aria-hidden="true">
          <span className={styles.horizon} />
          <ul className={styles.distances}>
            {labels.map((label) => (
              <li key={label} className={styles.distance}>
                {label}
              </li>
            ))}
          </ul>
          <span className={styles.city}>{event.city}</span>
        </div>
      )}
      <span className={`${styles.status} ${STATUS_CLASS[status] ?? ""}`} data-testid="event-status">
        {t(`events.status.${status}`)}
      </span>
    </div>
  );
}
