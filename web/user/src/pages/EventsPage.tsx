import { useTranslation } from "react-i18next";
import { EventCard } from "../components/EventCard";
import { QueryState } from "../components/QueryState";
import { usePublicEvents } from "../queries";
import styles from "./Page.module.css";

export function EventsPage() {
  const { t } = useTranslation("user");
  const events = usePublicEvents();

  return (
    <section>
      <h1 className={styles.title}>{t("events.title")}</h1>
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
