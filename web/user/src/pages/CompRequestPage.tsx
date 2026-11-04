import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { useApi } from "../api";
import { QueryState } from "../components/QueryState";
import { usePublicEvent } from "../queries";
import styles from "./CompRequestPage.module.css";
import formStyles from "./FreeSignupPage.module.css";
import { NotFoundPage } from "./NotFoundPage";
import pageStyles from "./Page.module.css";

type CompKind = Schemas["CompKind"];
type CompRequest = Schemas["CompRequest"];

const KINDS: CompKind[] = ["KOL", "CLUB", "SPONSOR", "MEDIA"];

const compKey = (slug: string) => ["comp-request", slug] as const;

/** 免费入场申请：KOL / 跑团团长 / 赞助商 / 媒体，主办方审批后发一个本人专用的免费报名码 */
export function CompRequestPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const api = useApi();
  const event = usePublicEvent(slug, { keepDataOnLanguageChange: true });
  const status = useQuery({
    queryKey: compKey(slug),
    queryFn: async () => unwrap(await api.GET("/app/events/{slug}/comp-request", { params: { path: { slug } } })),
  });

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(ev) => (
        <article>
          <h1 className={pageStyles.title}>{t("comp.title")}</h1>
          <p className={pageStyles.meta}>{ev.name}</p>
          <QueryState query={status}>
            {(st) => <CompBody slug={slug} open={st.open} request={st.request} />}
          </QueryState>
        </article>
      )}
    </QueryState>
  );
}

function CompBody({ slug, open, request }: { slug: string; open: boolean; request: CompRequest | null }) {
  const { t } = useTranslation("user");
  const [reapply, setReapply] = useState(false);

  if (request && request.status === "PENDING") {
    return (
      <section className={styles.card} data-testid="comp-pending">
        <span className={`${styles.pill} ${styles.warn}`}>{t("comp.status.PENDING")}</span>
        <p>{t("comp.pending", { name: request.applicantName })}</p>
        <p className={formStyles.hint}>{t("comp.pendingHint")}</p>
      </section>
    );
  }
  if (request && request.status === "APPROVED" && request.couponCode) {
    return (
      <section className={styles.card} data-testid="comp-approved">
        <span className={`${styles.pill} ${styles.ok}`}>{t("comp.status.APPROVED")}</span>
        <p>{t("comp.approved")}</p>
        <p className={styles.code} data-testid="comp-code">
          {request.couponCode}
        </p>
        <p className={formStyles.hint}>{t("comp.approvedHint")}</p>
        <Link
          to={`/events/${encodeURIComponent(slug)}/register?coupon=${encodeURIComponent(request.couponCode)}`}
          className={styles.cta}
          data-testid="comp-register"
        >
          {t("comp.register")}
        </Link>
      </section>
    );
  }
  if (!open) {
    return <p className={pageStyles.muted}>{t("comp.closed")}</p>;
  }
  if (request && request.status === "REJECTED" && !reapply) {
    return (
      <section className={styles.card} data-testid="comp-rejected">
        <span className={`${styles.pill} ${styles.stop}`}>{t("comp.status.REJECTED")}</span>
        <p>{t("comp.rejected")}</p>
        {request.reviewNote ? <p className={styles.note}>{request.reviewNote}</p> : null}
        <button type="button" className={styles.secondary} onClick={() => setReapply(true)}>
          {t("comp.reapply")}
        </button>
      </section>
    );
  }
  return <CompForm slug={slug} />;
}

function CompForm({ slug }: { slug: string }) {
  const { t } = useTranslation("user");
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CompKind>("KOL");
  const [profileUrl, setProfileUrl] = useState("");
  const [audience, setAudience] = useState("");
  const [note, setNote] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (body: Schemas["CreateCompRequest"]) =>
      unwrap(await api.POST("/app/events/{slug}/comp-request", { params: { path: { slug } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: compKey(slug) }),
  });
  const fields = create.error instanceof ApiError ? create.error.fields : {};

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === "") {
      setNameError(t("comp.nameRequired"));
      return;
    }
    setNameError(null);
    const body: Schemas["CreateCompRequest"] = { applicantName: name.trim(), kind };
    if (profileUrl.trim()) body.profileUrl = profileUrl.trim();
    if (audience.trim()) body.audience = audience.trim();
    if (note.trim()) body.note = note.trim();
    create.mutate(body);
  }

  const nameMsg = nameError ?? fields.applicantName;
  return (
    <form className={formStyles.form} onSubmit={submit} noValidate>
      <p className={pageStyles.muted}>{t("comp.intro")}</p>
      <fieldset className={styles.kinds}>
        <legend className={formStyles.label}>{t("comp.kind")}</legend>
        {KINDS.map((k) => (
          <label key={k} className={`${styles.chip} ${kind === k ? styles.chipOn : ""}`}>
            <input type="radio" name="comp-kind" value={k} checked={kind === k} onChange={() => setKind(k)} data-testid={`comp-kind-${k}`} />
            {t(`comp.kinds.${k}`)}
          </label>
        ))}
      </fieldset>
      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor="comp-name">
          {t("comp.name")}
        </label>
        <input
          id="comp-name"
          data-testid="comp-name"
          className={formStyles.input}
          maxLength={80}
          value={name}
          aria-invalid={nameMsg ? true : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {nameMsg ? (
          <p className={formStyles.fieldError} role="alert">
            {nameMsg}
          </p>
        ) : null}
      </div>
      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor="comp-url">
          {t("comp.profileUrl")}
        </label>
        <input
          id="comp-url"
          data-testid="comp-url"
          className={formStyles.input}
          type="url"
          inputMode="url"
          maxLength={300}
          placeholder="https://"
          value={profileUrl}
          aria-invalid={fields.profileUrl ? true : undefined}
          onChange={(e) => setProfileUrl(e.target.value)}
        />
        <p className={formStyles.hint}>{t("comp.profileUrlHint")}</p>
        {fields.profileUrl ? (
          <p className={formStyles.fieldError} role="alert">
            {fields.profileUrl}
          </p>
        ) : null}
      </div>
      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor="comp-audience">
          {t("comp.audience")}
        </label>
        <input
          id="comp-audience"
          className={formStyles.input}
          maxLength={80}
          placeholder={t("comp.audiencePlaceholder")}
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
        />
      </div>
      <div className={formStyles.field}>
        <label className={formStyles.label} htmlFor="comp-note">
          {t("comp.note")}
        </label>
        <textarea id="comp-note" className={styles.textarea} maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {create.isError && Object.keys(fields).length === 0 ? (
        <p className={formStyles.formError} role="alert">
          {create.error instanceof ApiError ? create.error.message : t("register.errors.network")}
        </p>
      ) : null}
      <button type="submit" className={formStyles.submit} disabled={create.isPending} data-testid="comp-submit">
        {create.isPending ? t("comp.submitting") : t("comp.submit")}
      </button>
    </form>
  );
}
