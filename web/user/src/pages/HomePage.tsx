import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { EventCard } from "../components/EventCard";
import { Hero } from "../components/Hero";
import { HowItWorks } from "../components/HowItWorks";
import { QueryState } from "../components/QueryState";
import { usePublicEvents } from "../queries";
import styles from "./Page.module.css";

const UPCOMING_LIMIT = 3;

export function HomePage() {
  const { t } = useTranslation("user");
  const events = usePublicEvents();

  return (
    <>
      <Hero events={events.data ?? []} />
      <section className={styles.section} aria-labelledby="upcoming-title">
        <div className={styles.sectionHead}>
          <h2 id="upcoming-title" className={styles.title}>
            {t("home.title")}
          </h2>
          <Link to="/events" className={styles.more}>
            {t("home.viewAll")}
          </Link>
        </div>
        <QueryState query={events}>
          {(items) =>
            items.length === 0 ? (
              <p className={styles.muted}>{t("events.empty")}</p>
            ) : (
              <div className={styles.grid}>
                {items.slice(0, UPCOMING_LIMIT).map((event) => (
                  <EventCard key={event.slug} event={event} />
                ))}
              </div>
            )
          }
        </QueryState>
      </section>
      <HowItWorks />
    </>
  );
}
