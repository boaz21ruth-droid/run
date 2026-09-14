import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatKm, formatRaceDate } from "../format";
import styles from "./EventCard.module.css";

export function EventCard({ event }: { event: Schemas["PublicEvent"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();

  return (
    <Link to={`/events/${event.slug}`} className={styles.card} data-testid="event-card">
      <p className={styles.date}>{formatRaceDate(event.raceDate, lang)}</p>
      <h3 className={styles.name}>{event.name}</h3>
      <p className={styles.city}>{event.city}</p>
      <ul className={styles.distances}>
        {event.categories.map((category) => (
          <li key={category.code} className={styles.distance}>
            {t("event.km", { km: formatKm(category.distanceM, lang) })}
          </li>
        ))}
      </ul>
    </Link>
  );
}
