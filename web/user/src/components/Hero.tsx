import { formatUsd } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { telegramBotLink } from "../auth/RequireRunner";
import { distanceLabels, eventStatus, nextEvent, totalRemaining, type PublicEvent } from "../events/status";
import { formatNumber, raceDayParts } from "../format";
import styles from "./Hero.module.css";

/** 首屏：河畔晨跑照片、口号、"下一场"卡片与真实统计 */
export function Hero({ events }: { events: readonly PublicEvent[] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const next = nextEvent(events);
  const openEvents = events.filter((e) => e.registrationOpen);
  const spots = openEvents.reduce((sum, e) => sum + totalRemaining(e), 0);
  const telegram = telegramBotLink();
  const [line1, line2] = t("home.hero.title").split("\n");

  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <picture>
        <source media="(max-width: 767px)" srcSet="/hero-mobile.webp" />
        <img className={styles.photo} src="/hero.webp" alt={t("home.hero.imageAlt")} fetchPriority="high" />
      </picture>
      <div className={styles.shade} aria-hidden="true" />

      <div className={styles.inner}>
        <div className={styles.copy}>
          <h1 id="hero-title" className={styles.title}>
            {line1}
            {line2 ? (
              <>
                <br />
                {line2}
              </>
            ) : null}
          </h1>
          <p className={styles.sub}>{t("home.hero.sub")}</p>
          <div className={styles.actions}>
            <Link to="/events" className={styles.primary}>
              {t("home.hero.cta")}
            </Link>
            {telegram ? (
              <a href={telegram} target="_blank" rel="noreferrer" className={styles.ghost}>
                {t("home.hero.telegram")}
              </a>
            ) : null}
          </div>
        </div>

        {next ? <NextRaceCard event={next} /> : null}

        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dd className={styles.statValue}>{formatNumber(openEvents.length, lang)}</dd>
            <dt className={styles.statLabel}>{t("home.stats.open")}</dt>
          </div>
          <div className={styles.stat}>
            <dd className={styles.statValue}>{formatNumber(spots, lang)}</dd>
            <dt className={styles.statLabel}>{t("home.stats.spots")}</dt>
          </div>
          {next ? (
            <div className={styles.stat}>
              <dd className={styles.statValue}>
                {raceDayParts(next.raceDate, lang).day}
                <span className={styles.statUnit}>{raceDayParts(next.raceDate, lang).month}</span>
              </dd>
              <dt className={styles.statLabel}>{t("home.stats.nextStart")}</dt>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

function NextRaceCard({ event }: { event: PublicEvent }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const status = eventStatus(event);
  const day = raceDayParts(event.raceDate, lang);
  const remaining = totalRemaining(event);
  const canRegister = status === "open" || status === "almostFull" || status === "free";

  return (
    <aside className={styles.next} data-testid="next-race">
      <span className={styles.nextLabel}>{t("home.next.label")}</span>
      <h2 className={styles.nextName}>{event.name}</h2>
      <p className={styles.nextWhen}>
        <span className={styles.nextDay}>{day.day}</span>
        <span className={styles.nextMonth}>{day.month}</span>
        <span className={styles.nextCity}>{event.city}</span>
      </p>
      <ul className={styles.nextDistances} aria-label={t("event.categories")}>
        {distanceLabels(event).map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <p className={styles.nextFoot}>
        <span className={styles.nextPrice}>
          {event.eventType === "FREE_ACTIVITY"
            ? t("event.freeEntry")
            : event.fromPriceCents != null
              ? t("event.from", { price: formatUsd(event.fromPriceCents) })
              : ""}
        </span>
        <span className={styles.nextRemaining}>
          {remaining > 0 ? t("home.next.remaining", { n: formatNumber(remaining, lang) }) : t("home.next.soldOut")}
        </span>
      </p>
      <div className={styles.nextActions}>
        {canRegister ? (
          <Link
            to={event.eventType === "FREE_ACTIVITY" ? `/events/${event.slug}/free-signup` : `/events/${event.slug}/register`}
            className={styles.primary}
            data-testid="next-race-register"
          >
            {t("home.next.register")}
          </Link>
        ) : null}
        <Link to={`/events/${event.slug}`} className={styles.link}>
          {t("home.next.details")}
        </Link>
      </div>
    </aside>
  );
}
