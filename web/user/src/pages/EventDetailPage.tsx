import { ApiError } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatKm, formatNumber, formatRaceDate, formatTime } from "../format";
import { usePublicEvent } from "../queries";
import { registrationAvailable } from "../register/model";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

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
      {(data) => (
        <article>
          <h1 className={styles.title}>{data.name}</h1>
          <p className={styles.meta}>
            <span>
              {t("event.date")}：{formatRaceDate(data.raceDate, lang)}
            </span>
            <span>
              {t("event.city")}：{data.city}
            </span>
          </p>
          {registrationAvailable(data) ? (
            data.categories.some((category) => !category.soldOut) ? (
              <Link to={`/events/${data.slug}/register`} className={styles.cta} data-testid="register-button">
                {t("register.cta")}
              </Link>
            ) : (
              <p className={styles.muted} data-testid="register-sold-out">
                {t("register.allSoldOut")}
              </p>
            )
          ) : null}
          {data.eventType === "FREE_ACTIVITY" && data.registrationOpen ? (
            <Link
              to={`/events/${data.slug}/free-signup`}
              className={styles.freeSignupAction}
              data-testid="free-signup-button"
            >
              {t("free.button")}
            </Link>
          ) : null}
          <h2 className={styles.title}>{t("event.categories")}</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t("event.categories")}</th>
                  <th scope="col">{t("event.distance")}</th>
                  <th scope="col">{t("event.capacity")}</th>
                  <th scope="col">{t("event.start")}</th>
                  <th scope="col">{t("event.cutoff")}</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((category) => (
                  <tr key={category.code}>
                    <th scope="row">
                      {category.name}
                      {category.soldOut ? <span className={styles.badge}>{t("register.soldOut")}</span> : null}
                    </th>
                    <td className={styles.num}>{t("event.km", { km: formatKm(category.distanceM, lang) })}</td>
                    <td className={styles.num}>{formatNumber(category.capacity, lang)}</td>
                    <td className={styles.num}>{formatTime(category.startAt, lang)}</td>
                    <td className={styles.num}>{formatTime(category.cutoffAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </QueryState>
  );
}
