import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { totalRemaining } from "../events/status";
import { formatNumber, raceDayParts } from "../format";
import styles from "./EventCard.module.css";
import { EventCover } from "./EventCover";

export function EventCard({ event }: { event: Schemas["PublicEvent"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const day = raceDayParts(event.raceDate, lang);
  const remaining = totalRemaining(event);

  return (
    <Link to={`/events/${event.slug}`} className={styles.card} data-testid="event-card">
      <EventCover event={event} />
      <div className={styles.body}>
        <div className={styles.dateBlock} aria-hidden="true">
          <span className={styles.day}>{day.day}</span>
          <span className={styles.month}>{day.month}</span>
        </div>
        <div className={styles.text}>
          <h3 className={styles.name}>{event.name}</h3>
          <p className={styles.meta}>
            <span className="visually-hidden">{day.full}</span>
            {event.city}
          </p>
          <p className={styles.foot}>
            <span className={styles.price}>
              {event.eventType === "FREE_ACTIVITY"
                ? t("event.freeEntry")
                : event.fromPriceCents != null
                  ? t("event.from", { price: formatUsd(event.fromPriceCents) })
                  : ""}
            </span>
            <span className={styles.remaining}>{t("event.remaining", { n: formatNumber(remaining, lang) })}</span>
          </p>
        </div>
      </div>
    </Link>
  );
}
