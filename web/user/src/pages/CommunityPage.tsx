import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useCheckin, useCommunityFeed, type FeedKind } from "../community/api";
import styles from "../community/Community.module.css";
import { QueryState } from "../components/QueryState";
import { formatActivityTime } from "../format";
import pageStyles from "./Page.module.css";

type Item = Schemas["CommunityFeedItem"];

/** 跑团页（设计稿第 07 屏）：官方免费活动与跑团活动混排、今天谁在跑 */
export function CommunityPage() {
  const { t } = useTranslation("user");
  const [kind, setKind] = useState<FeedKind>("ALL");
  const [city, setCity] = useState("");
  const feed = useCommunityFeed(kind, city);
  const chips: { key: string; label: string; active: boolean; onClick: () => void }[] = [
    {
      key: "ALL",
      label: t("community.filter.all"),
      active: kind === "ALL" && !city,
      onClick: () => {
        setKind("ALL");
        setCity("");
      },
    },
    { key: "OFFICIAL", label: t("community.filter.official"), active: kind === "OFFICIAL", onClick: () => setKind("OFFICIAL") },
    { key: "CLUB", label: t("community.filter.club"), active: kind === "CLUB", onClick: () => setKind("CLUB") },
    ...(feed.data?.cities ?? []).map((c) => ({
      key: `city-${c}`,
      label: c,
      active: city === c,
      onClick: () => setCity(city === c ? "" : c),
    })),
  ];

  return (
    <section className={styles.page}>
      <div className={styles.head}>
        <h1 className={pageStyles.title}>{t("community.title")}</h1>
        <Link to="/community/new" className={styles.publish} data-testid="community-publish">
          + {t("community.publish")}
        </Link>
      </div>
      <div className={styles.chips} role="group" aria-label={t("community.filter.label")}>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={c.active ? styles.chipOn : styles.chip}
            aria-pressed={c.active}
            onClick={c.onClick}
            data-testid={`community-filter-${c.key}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <QueryState query={feed}>
        {(data) => (
          <>
            <CheckinStrip checkins={data.checkins} />
            {data.items.length === 0 ? (
              <p className={pageStyles.muted} data-testid="community-empty">
                {t("community.empty")}
              </p>
            ) : (
              <ul className={styles.feed}>
                {data.items.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    {item.kind === "OFFICIAL" ? <OfficialCard item={item} /> : <ClubCard item={item} />}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </QueryState>
      <p className={styles.disclaimer}>{t("community.disclaimer")}</p>
    </section>
  );
}

function CheckinStrip({ checkins }: { checkins: Schemas["CommunityCheckin"][] }) {
  const { t } = useTranslation("user");
  const { status } = useAuth();
  const authed = status === "authenticated";
  const { state, toggle } = useCheckin(authed);
  const checkedIn = state.data?.checkedIn ?? false;
  return (
    <section className={styles.strip} aria-labelledby="checkin-title">
      <div className={styles.stripHead}>
        <h2 id="checkin-title" className={styles.stripTitle}>
          {t("community.checkin.title")}
        </h2>
        <span className={styles.muted}>{t("community.checkin.ttl")}</span>
      </div>
      <ul className={styles.people}>
        {authed ? (
          <li>
            <button
              type="button"
              className={checkedIn ? styles.meOn : styles.me}
              aria-pressed={checkedIn}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!checkedIn)}
              data-testid="community-checkin"
            >
              {checkedIn ? "✓" : "+"}
            </button>
            <span>{checkedIn ? t("community.checkin.on") : t("community.checkin.me")}</span>
          </li>
        ) : null}
        {checkins.map((c, i) => (
          <li key={`${c.initials}-${i}`}>
            <span className={styles.avatar} aria-hidden="true">
              {c.initials}
            </span>
            <span>{c.name}</span>
          </li>
        ))}
        {!authed && checkins.length === 0 ? <li className={styles.muted}>{t("community.checkin.nobody")}</li> : null}
      </ul>
    </section>
  );
}

function Initials({ list }: { list: string[] }) {
  return list.length > 0 ? (
    <span className={styles.stack} aria-hidden="true">
      {list.map((x, i) => (
        <span key={`${x}-${i}`} className={styles.mini}>
          {x}
        </span>
      ))}
    </span>
  ) : null;
}

function OfficialCard({ item }: { item: Item }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const full = item.capacity > 0 && item.joinedCount >= item.capacity;
  return (
    <article className={styles.card} data-testid={`community-official-${item.id}`}>
      {item.coverUrl ? <img className={styles.cover} src={item.coverUrl} alt="" /> : null}
      <div className={styles.cardBody}>
        <div className={styles.tags}>
          <span className={styles.tagOfficial}>{t("community.filter.official")}</span>
        </div>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        <p className={styles.host}>
          {t("community.official")} <span className={styles.verified} aria-label={t("community.verified")}>✓</span>
        </p>
        <p className={styles.meta}>
          {formatActivityTime(item.startsAt, lang)} · {item.location}
        </p>
        <div className={styles.foot}>
          <span className={styles.count}>
            {item.capacity > 0 ? t("community.count", { joined: item.joinedCount, capacity: item.capacity }) : null}
          </span>
          <Link to={`/events/${item.eventSlug ?? ""}`} className={styles.cta}>
            {full ? t("community.viewEvent") : t("community.freeSignup")}
          </Link>
        </div>
      </div>
    </article>
  );
}

function ClubCard({ item }: { item: Item }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const full = item.joinedCount >= item.capacity;
  return (
    <article className={styles.card} data-testid={`community-club-${item.id}`}>
      <div className={styles.cardBody}>
        <div className={styles.tags}>
          <span className={styles.tag}>{t("community.filter.club")}</span>
          {item.hostName ? <span className={styles.tagHost}>{item.hostName}</span> : null}
        </div>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        <p className={styles.meta}>
          {formatActivityTime(item.startsAt, lang)} · {item.location}
          {item.distanceText ? ` · ${item.distanceText}` : ""}
        </p>
        <div className={styles.foot}>
          <span className={styles.count}>
            <Initials list={item.joinerInitials} />
            {!full
              ? t("community.count", { joined: item.joinedCount, capacity: item.capacity })
              : item.waitlistCount > 0
                ? t("community.fullWaitlist", { n: item.waitlistCount })
                : t("community.fullOpen")}
          </span>
          {item.feeNote ? <span className={styles.fee}>{item.feeNote}</span> : null}
          <Link to={`/community/${item.id}`} className={styles.secondaryCta} data-testid={`community-open-${item.id}`}>
            {full ? t("community.waitlist") : t("community.join")}
          </Link>
        </div>
      </div>
    </article>
  );
}
