import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { EventCard } from "../components/EventCard";
import { QueryState } from "../components/QueryState";
import { usePublicEvents } from "../queries";
import styles from "./Page.module.css";

const UPCOMING_LIMIT = 3;

export function HomePage() {
  const { t } = useTranslation("user");
  const events = usePublicEvents();

  return (
    <section>
      <h1 className={styles.title}>{t("home.title")}</h1>
      <QueryState query={events}>
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted}>{t("events.empty")}</p>
          ) : (
            <>
              <div className={styles.grid}>
                {items.slice(0, UPCOMING_LIMIT).map((event) => (
                  <EventCard key={event.slug} event={event} />
                ))}
              </div>
              <Link to="/events" className={styles.more}>
                {t("home.viewAll")}
              </Link>
            </>
          )
        }
      </QueryState>
    </section>
  );
}
