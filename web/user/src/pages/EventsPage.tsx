import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { EventCard } from "../components/EventCard";
import { QueryState } from "../components/QueryState";
import { formatNumber } from "../format";
import { usePublicEvents } from "../queries";
import styles from "./Page.module.css";

export function EventsPage() {
  const { t } = useTranslation("user");
  const lang = useLang();
  const events = usePublicEvents();

  return (
    <section>
      <div className={styles.sectionHead}>
        <h1 className={styles.title}>{t("events.title")}</h1>
        {events.data && events.data.length > 0 ? (
          <span className={styles.count}>{t("events.count", { n: formatNumber(events.data.length, lang) })}</span>
        ) : null}
      </div>
      <QueryState query={events}>
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted}>{t("events.empty")}</p>
          ) : (
            <div className={styles.grid}>
              {items.map((event) => (
                <EventCard key={event.slug} event={event} />
              ))}
            </div>
          )
        }
      </QueryState>
    </section>
  );
}
