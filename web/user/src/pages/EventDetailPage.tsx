import { ApiError, formatUsd } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { EventCover } from "../components/EventCover";
import { QueryState } from "../components/QueryState";
import { eventStatus, totalRemaining } from "../events/status";
import { formatKm, formatNumber, formatRaceDate, formatTime, raceDayParts } from "../format";
import { usePublicEvent } from "../queries";
import { registrationAvailable } from "../register/model";
import styles from "./EventDetail.module.css";
import { NotFoundPage } from "./NotFoundPage";

export function EventDetailPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const lang = useLang();
  const event = usePublicEvent(slug);

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) => {
        const status = eventStatus(data);
        const day = raceDayParts(data.raceDate, lang);
        const canRegister = registrationAvailable(data) && data.categories.some((c) => !c.soldOut);
        const allSoldOut = registrationAvailable(data) && !data.categories.some((c) => !c.soldOut);
        const freeOpen = data.eventType === "FREE_ACTIVITY" && data.registrationOpen;

        // 桌面端按钮在横幅里，手机端固定在底部；同一动作渲染两份，测试 id 只挂在横幅那一份上
        const renderAction = (primary: boolean) =>
          canRegister ? (
            <Link
              to={`/events/${data.slug}/register`}
              className={styles.cta}
              data-testid={primary ? "register-button" : undefined}
            >
              {t("register.cta")}
            </Link>
          ) : freeOpen ? (
            <Link
              to={`/events/${data.slug}/free-signup`}
              className={styles.cta}
              data-testid={primary ? "free-signup-button" : undefined}
            >
              {t("free.button")}
            </Link>
          ) : allSoldOut ? (
            <p className={styles.soldOutNote} data-testid={primary ? "register-sold-out" : undefined}>
              {t("register.allSoldOut")}
            </p>
          ) : null;
        const action = renderAction(true);

        return (
          <article className={styles.page}>
            <header className={styles.band}>
              <EventCover event={data} tall />
              <div className={styles.bandBody}>
                <p className={styles.when}>
                  <span className={styles.day}>{day.day}</span>
                  <span className={styles.month}>{day.month}</span>
                  <span className="visually-hidden">{formatRaceDate(data.raceDate, lang)}</span>
                  <span className={styles.city}>{data.city}</span>
                </p>
                <h1 className={styles.title}>{data.name}</h1>
                <p className={styles.summary}>
                  <span className={styles.price}>
                    {data.eventType === "FREE_ACTIVITY"
                      ? t("event.freeEntry")
                      : data.fromPriceCents != null
                        ? t("event.from", { price: formatUsd(data.fromPriceCents) })
                        : ""}
                  </span>
                  <span className={styles.remaining}>
                    {t("event.spotsLeft")} {formatNumber(totalRemaining(data), lang)}
                  </span>
                  <span className={styles.statusText}>{t(`events.status.${status}`)}</span>
                </p>
                <div className={styles.actions}>{action}</div>
              </div>
            </header>

            <section className={styles.section} aria-labelledby="categories-title">
              <h2 id="categories-title" className={styles.sectionTitle}>
                {t("event.categories")}
              </h2>
              <ul className={styles.categories}>
                {data.categories.map((category) => {
                  const remaining = category.remaining ?? (category.soldOut ? 0 : category.capacity);
                  const ratio = category.capacity > 0 ? Math.min(1, Math.max(0, remaining / category.capacity)) : 0;
                  return (
                    <li key={category.code} className={styles.category} data-testid={`category-${category.code}`}>
                      <div className={styles.categoryHead}>
                        <span className={styles.distance}>{formatKm(category.distanceM, lang)}</span>
                        <span className={styles.km}>{t("event.km", { km: "" }).trim()}</span>
                        {category.soldOut ? <span className={styles.badge}>{t("register.soldOut")}</span> : null}
                      </div>
                      <h3 className={styles.categoryName}>{category.name}</h3>
                      <dl className={styles.times}>
                        <div>
                          <dt>{t("event.start")}</dt>
                          <dd>{formatTime(category.startAt, lang)}</dd>
                        </div>
                        <div>
                          <dt>{t("event.cutoff")}</dt>
                          <dd>{formatTime(category.cutoffAt, lang)}</dd>
                        </div>
                      </dl>
                      <div className={styles.capacity}>
                        <div className={styles.capacityBar} aria-hidden="true">
                          <span className={styles.capacityFill} style={{ width: `${ratio * 100}%` }} />
                        </div>
                        <span className={styles.capacityText}>
                          {t("event.spotsLeft")}{" "}
                          {t("event.spotsOf", {
                            remaining: formatNumber(remaining, lang),
                            capacity: formatNumber(category.capacity, lang),
                          })}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {action ? <div className={styles.stickyBar}>{renderAction(false)}</div> : null}
          </article>
        );
      }}
    </QueryState>
  );
}
