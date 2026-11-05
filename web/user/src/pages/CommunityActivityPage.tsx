import { ApiError } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useActivityAction, useActivityView } from "../community/api";
import styles from "../community/Community.module.css";
import { QueryState } from "../components/QueryState";
import { formatActivityTime } from "../format";
import { NotFoundPage } from "./NotFoundPage";
import pageStyles from "./Page.module.css";

/** 跑团活动详情：参加 / 候补 / 退出；参加后（或发起人设为公开时）看到联系方式；发起人看审核状态、可以取消 */
export function CommunityActivityPage() {
  const { id = "" } = useParams();
  const activityId = Number(id);
  const { t } = useTranslation("user");
  const lang = useLang();
  const view = useActivityView(activityId);
  const action = useActivityAction(activityId);
  const [confirmClose, setConfirmClose] = useState(false);

  if (!Number.isInteger(activityId) || activityId <= 0 || (view.error instanceof ApiError && view.error.status === 404)) {
    return <NotFoundPage />;
  }
  return (
    <QueryState query={view}>
      {({ activity: a, myStatus, isAuthor, contact }) => {
        const full = a.joinedCount >= a.capacity;
        const started = Date.parse(a.startsAt) <= Date.now();
        const live = a.status === "PUBLISHED" && !a.frozen && !started;
        return (
          <article className={styles.detail}>
            <div className={styles.tags}>
              <span className={styles.tag}>{t(`community.tags.${a.tag}`)}</span>
              {a.hostName ? <span className={styles.tagHost}>{a.hostName}</span> : null}
            </div>
            <h1 className={pageStyles.title}>{a.title}</h1>
            {isAuthor ? <AuthorStatus status={a.status} rejectCode={a.rejectCode} frozen={a.frozen} /> : null}
            <dl className={styles.facts}>
              <div>
                <dt>{t("community.fields.time")}</dt>
                <dd>{formatActivityTime(a.startsAt, lang)}</dd>
              </div>
              <div>
                <dt>{t("community.fields.meetPoint")}</dt>
                <dd>
                  {a.location} · {a.meetPoint}
                </dd>
              </div>
              {a.distanceText ? (
                <div>
                  <dt>{t("community.fields.distance")}</dt>
                  <dd>{a.distanceText}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("community.fields.fee")}</dt>
                <dd>{a.feeNote}</dd>
              </div>
              <div>
                <dt>{t("community.fields.spots")}</dt>
                <dd data-testid="community-spots">
                  {t("community.count", { joined: a.joinedCount, capacity: a.capacity })}
                  {a.waitlistCount > 0 ? ` · ${t("community.waitlistCount", { n: a.waitlistCount })}` : ""}
                </dd>
              </div>
              <div>
                <dt>{t("community.fields.host")}</dt>
                <dd>{a.authorName}</dd>
              </div>
            </dl>
            <p className={styles.bodyText}>{a.body}</p>

            {contact ? (
              <section className={styles.contact} data-testid="community-contact">
                <h2 className={styles.stripTitle}>{t("community.contactTitle")}</h2>
                {contact.telegram ? (
                  <a href={`https://t.me/${contact.telegram}`} target="_blank" rel="noreferrer">
                    @{contact.telegram}
                  </a>
                ) : null}
                {contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : null}
              </section>
            ) : !isAuthor ? (
              <p className={styles.muted}>{t("community.contactHidden")}</p>
            ) : null}

            {action.isError ? (
              <p className={styles.error} role="alert">
                {action.error instanceof ApiError ? action.error.message : t("register.errors.network")}
              </p>
            ) : null}

            {isAuthor ? (
              a.status === "REVIEWING" || a.status === "PUBLISHED" ? (
                confirmClose ? (
                  <div className={styles.confirm}>
                    <p>{t("community.closeConfirm")}</p>
                    <div className={styles.actions}>
                      <button type="button" className={styles.secondaryCta} onClick={() => setConfirmClose(false)}>
                        {t("community.keep")}
                      </button>
                      <button
                        type="button"
                        className={styles.danger}
                        disabled={action.isPending}
                        onClick={() => action.mutate("close")}
                        data-testid="community-close-confirm"
                      >
                        {t("community.close")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className={styles.linkButton} onClick={() => setConfirmClose(true)} data-testid="community-close">
                    {t("community.close")}
                  </button>
                )
              ) : null
            ) : myStatus === "NONE" ? (
              <button
                type="button"
                className={styles.ctaWide}
                disabled={!live || action.isPending}
                onClick={() => action.mutate("join")}
                data-testid="community-join"
              >
                {!live ? t("community.notOpen") : full ? t("community.joinWaitlist") : t("community.join")}
              </button>
            ) : (
              <div className={styles.joined} data-testid="community-my-status" data-status={myStatus}>
                <span>{myStatus === "JOINED" ? t("community.youJoined") : t("community.youWaitlisted")}</span>
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={action.isPending}
                  onClick={() => action.mutate("leave")}
                  data-testid="community-leave"
                >
                  {myStatus === "JOINED" ? t("community.leave") : t("community.leaveWaitlist")}
                </button>
              </div>
            )}
          </article>
        );
      }}
    </QueryState>
  );
}

function AuthorStatus({ status, rejectCode, frozen }: { status: string; rejectCode: string | null; frozen: boolean }) {
  const { t } = useTranslation("user");
  return (
    <p className={styles.authorStatus} data-testid="community-author-status" data-status={status}>
      <span className={styles.statusPill}>{frozen ? t("community.status.FROZEN") : t(`community.status.${status}`)}</span>
      {status === "REJECTED" && rejectCode ? <span>{t(`community.reject.${rejectCode}`)}</span> : null}
      {status === "REVIEWING" ? <span>{t("community.reviewingHint")}</span> : null}
    </p>
  );
}
