import { unwrap } from "@werun/api-client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api";
import { saveReferral } from "../promo/referral";
import pageStyles from "./Page.module.css";

/** /r/<slug>：推荐链接落地。计一次点击、记下来源与推荐码，然后换成赛事页（不留这条历史） */
export function ReferralPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const api = useApi();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // StrictMode 下 effect 会跑两次；点击只计一次
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const visit = unwrap(await api.POST("/referrals/{slug}/visit", { params: { path: { slug } } }));
        saveReferral(visit, slug.toLowerCase());
        void navigate(`/events/${encodeURIComponent(visit.eventSlug)}`, { replace: true });
      } catch {
        setFailed(true);
      }
    })();
  }, [api, navigate, slug]);

  if (!failed) {
    return <p className={pageStyles.muted}>{t("referral.opening")}</p>;
  }
  return (
    <article>
      <h1 className={pageStyles.title}>{t("referral.invalidTitle")}</h1>
      <p className={pageStyles.muted}>{t("referral.invalid")}</p>
      <Link to="/events" className={pageStyles.more}>
        {t("referral.browse")}
      </Link>
    </article>
  );
}
