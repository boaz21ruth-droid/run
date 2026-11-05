import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useMyActivities } from "../community/api";
import styles from "../community/Community.module.css";
import { QueryState } from "../components/QueryState";
import { formatActivityTime } from "../format";
import pageStyles from "./Page.module.css";

/** 我发布的跑团活动与审核状态 */
export function CommunityMinePage() {
  const { t } = useTranslation("user");
  const lang = useLang();
  const mine = useMyActivities();
  return (
    <section className={styles.page}>
      <div className={styles.head}>
        <h1 className={pageStyles.title}>{t("community.mine.title")}</h1>
        <Link to="/community/new" className={styles.publish}>
          + {t("community.publish")}
        </Link>
      </div>
      <QueryState query={mine}>
        {(items) =>
          items.length === 0 ? (
            <p className={pageStyles.muted}>{t("community.mine.empty")}</p>
          ) : (
            <ul className={styles.feed}>
              {items.map((a) => (
                <li key={a.id}>
                  <Link to={`/community/${a.id}`} className={styles.mineRow} data-testid={`community-mine-${a.id}`}>
                    <span>
                      <b>{a.title}</b>
                      <span className={styles.meta}>{formatActivityTime(a.startsAt, lang)}</span>
                    </span>
                    <span className={styles.statusPill}>{a.frozen ? t("community.status.FROZEN") : t(`community.status.${a.status}`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}
