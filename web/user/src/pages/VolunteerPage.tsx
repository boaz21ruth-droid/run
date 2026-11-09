import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useApi } from "../api";
import { QueryState } from "../components/QueryState";
import { formatMonthDay } from "../format";
import { usePublicEvent } from "../queries";
import styles from "../volunteer/Volunteer.module.css";
import formStyles from "./FreeSignupPage.module.css";
import { NotFoundPage } from "./NotFoundPage";
import pageStyles from "./Page.module.css";

type Info = Schemas["AppVolunteerInfo"];
type Application = Schemas["VolunteerApplication"];
type Role = Schemas["PublicVolunteerRole"];

const MAX_ROLES = 3;
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
const volunteerKey = (slug: string) => ["volunteer", slug] as const;

/** 赛事日期（纯日期）按金边当天显示成 11/13 */
const shortDay = (date: string, lang: ReturnType<typeof useLang>) => formatMonthDay(`${date}T12:00:00Z`, lang);

/** 成为赛事志愿者（设计稿第 09 屏）：选日期与 1–3 个岗位，主办方按席位分配，满员的进候补 */
export function VolunteerPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const api = useApi();
  const event = usePublicEvent(slug, { keepDataOnLanguageChange: true });
  const info = useQuery({
    queryKey: volunteerKey(slug),
    queryFn: async () => unwrap(await api.GET("/app/events/{slug}/volunteer", { params: { path: { slug } } })),
  });

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }
  return (
    <QueryState query={event}>
      {(ev) => (
        <article className={styles.page}>
          <span className={styles.eventPill}>{ev.name}</span>
          <h1 className={pageStyles.title}>{t("volunteer.title")}</h1>
          <QueryState query={info}>{(data) => <VolunteerBody slug={slug} info={data} />}</QueryState>
        </article>
      )}
    </QueryState>
  );
}

function VolunteerBody({ slug, info }: { slug: string; info: Info }) {
  const { t } = useTranslation("user");
  const [reapply, setReapply] = useState(false);
  const app = info.application;
  const active = app && (app.status === "PENDING" || app.status === "ASSIGNED" || app.status === "WAITLIST");

  return (
    <>
      {info.note ? <p className={styles.note}>{info.note}</p> : null}
      {active ? (
        <StatusCard slug={slug} app={app} roles={info.roles} />
      ) : !info.open ? (
        <p className={pageStyles.muted} data-testid="volunteer-closed">
          {t("volunteer.closed")}
        </p>
      ) : app?.status === "REJECTED" && !reapply ? (
        <section className={styles.card} data-testid="volunteer-rejected">
          <span className={`${styles.pill} ${styles.pillREJECTED}`}>{t("volunteer.status.REJECTED")}</span>
          <p>{t("volunteer.rejected")}</p>
          {app.reviewNote ? <p className={styles.reviewNote}>{app.reviewNote}</p> : null}
          <button type="button" className={styles.secondary} onClick={() => setReapply(true)}>
            {t("volunteer.reapply")}
          </button>
        </section>
      ) : (
        <VolunteerForm slug={slug} info={info} />
      )}
    </>
  );
}

function StatusCard({ slug, app, roles }: { slug: string; app: Application; roles: Role[] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const withdraw = useMutation({
    mutationFn: async () => unwrap(await api.POST("/app/events/{slug}/volunteer/withdraw", { params: { path: { slug } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: volunteerKey(slug) }),
  });
  const chosen = app.roleIds.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean);
  return (
    <section className={styles.card} data-testid="volunteer-status" data-status={app.status}>
      <span className={`${styles.pill} ${styles[`pill${app.status}`]}`}>{t(`volunteer.status.${app.status}`)}</span>
      {app.status === "ASSIGNED" ? (
        <p className={styles.assigned} data-testid="volunteer-assigned">
          {t("volunteer.assigned", { role: app.assignedRoleName ?? "" })}
        </p>
      ) : (
        <p>{t(app.status === "WAITLIST" ? "volunteer.waitlist" : "volunteer.pending")}</p>
      )}
      <dl className={styles.summary}>
        <div>
          <dt>{t("volunteer.summary.dates")}</dt>
          <dd>{app.fullAvailability ? t("volunteer.full") : app.dates.map((d) => shortDay(d, lang)).join(" · ")}</dd>
        </div>
        <div>
          <dt>{t("volunteer.summary.roles")}</dt>
          <dd>{chosen.join(" · ") || "—"}</dd>
        </div>
      </dl>
      <p className={formStyles.hint}>{t("volunteer.contactHint")}</p>
      {confirming ? (
        <div className={styles.confirm}>
          <p>{t("volunteer.withdrawConfirm")}</p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>
              {t("volunteer.keep")}
            </button>
            <button
              type="button"
              className={styles.danger}
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate()}
              data-testid="volunteer-withdraw-confirm"
            >
              {t("volunteer.withdraw")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.linkButton} onClick={() => setConfirming(true)} data-testid="volunteer-withdraw">
          {t("volunteer.withdraw")}
        </button>
      )}
      {withdraw.isError ? (
        <p className={formStyles.fieldError} role="alert">
          {withdraw.error instanceof ApiError ? withdraw.error.message : t("register.errors.network")}
        </p>
      ) : null}
    </section>
  );
}

function VolunteerForm({ slug, info }: { slug: string; info: Info }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const api = useApi();
  const queryClient = useQueryClient();
  const [full, setFull] = useState(true);
  const [dates, setDates] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [tshirtSize, setTshirtSize] = useState("");
  const [note, setNote] = useState("");
  const [conduct, setConduct] = useState(false);
  const [media, setMedia] = useState(false);
  const [seats, setSeats] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: async (body: Schemas["CreateVolunteerApplication"]) =>
      unwrap(await api.POST("/app/events/{slug}/volunteer", { params: { path: { slug } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: volunteerKey(slug) }),
    onError: (error) => {
      if (error instanceof ApiError) {
        setErrors(error.fields);
      }
    },
  });

  const toggleRole = (id: number) =>
    setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : prev.length < MAX_ROLES ? [...prev, id] : prev));
  const toggleDate = (d: string) => setDates((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (fullName.trim() === "") found.fullName = t("profiles.errors.required");
    if (!/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s()-]/g, ""))) found.phone = t("volunteer.errors.phone");
    if (!full && dates.length === 0) found.dates = t("volunteer.errors.dates");
    if (roleIds.length === 0) found.roleIds = t("volunteer.errors.roles");
    if (!conduct || !seats) found.conductAccepted = t("volunteer.errors.conduct");
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    const body: Schemas["CreateVolunteerApplication"] = {
      fullName: fullName.trim(),
      phone: phone.trim(),
      fullAvailability: full,
      roleIds,
      mediaConsent: media,
      conductAccepted: true,
    };
    if (!full) body.dates = [...dates].sort();
    if (tshirtSize) body.tshirtSize = tshirtSize as Schemas["CreateVolunteerApplication"]["tshirtSize"];
    if (note.trim()) body.note = note.trim();
    create.mutate(body);
  }

  const formError = create.error instanceof ApiError && Object.keys(create.error.fields).length === 0 ? create.error.message : null;
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("volunteer.datesTitle")}</h2>
        <div className={styles.segment} role="radiogroup" aria-label={t("volunteer.datesTitle")}>
          {[true, false].map((value) => (
            <button
              key={String(value)}
              type="button"
              role="radio"
              aria-checked={full === value}
              className={full === value ? styles.segmentOn : styles.segmentOff}
              onClick={() => setFull(value)}
              data-testid={value ? "volunteer-full" : "volunteer-partial"}
            >
              {t(value ? "volunteer.full" : "volunteer.partial")}
            </button>
          ))}
        </div>
        {full ? (
          <p className={formStyles.hint}>{t("volunteer.fullHint", { dates: info.dates.map((d) => shortDay(d, lang)).join("、") })}</p>
        ) : (
          <div className={styles.chips}>
            {info.dates.map((d) => (
              <label key={d} className={`${styles.chip} ${dates.includes(d) ? styles.chipOn : ""}`}>
                <input type="checkbox" checked={dates.includes(d)} onChange={() => toggleDate(d)} data-testid={`volunteer-date-${d}`} />
                {shortDay(d, lang)}
              </label>
            ))}
          </div>
        )}
        {errors.dates ? <p className={formStyles.fieldError}>{errors.dates}</p> : null}
      </section>

      <section>
        <div className={styles.rolesHead}>
          <h2 className={styles.cardTitle}>{t("volunteer.rolesTitle", { max: MAX_ROLES })}</h2>
          <span className={formStyles.hint}>{t("volunteer.picked", { n: roleIds.length })}</span>
        </div>
        <ul className={styles.roles}>
          {info.roles.map((role) => {
            const on = roleIds.includes(role.id);
            const ratio = role.capacity > 0 ? (role.capacity - role.remaining) / role.capacity : 1;
            const isFull = role.remaining === 0;
            return (
              <li key={role.id}>
                <label className={`${styles.role} ${on ? styles.roleOn : ""}`} data-testid={`volunteer-role-${role.id}`}>
                  <input type="checkbox" checked={on} disabled={!on && roleIds.length >= MAX_ROLES} onChange={() => toggleRole(role.id)} />
                  <span className={styles.roleBody}>
                    <b>{role.name}</b>
                    {role.schedule ? <span className={styles.roleMeta}>{role.schedule}</span> : null}
                    <span className={styles.bar} aria-hidden="true">
                      <span className={isFull ? styles.barFull : styles.barFill} style={{ width: `${Math.min(1, ratio) * 100}%` }} />
                    </span>
                  </span>
                  {isFull ? (
                    <span className={styles.fullBadge}>{t("volunteer.fullBadge")}</span>
                  ) : (
                    <span className={styles.seats}>
                      <b>{role.remaining}</b>
                      <span>{t("volunteer.seats")}</span>
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <p className={formStyles.hint}>{t("volunteer.rolesHint")}</p>
        {errors.roleIds ? <p className={formStyles.fieldError}>{errors.roleIds}</p> : null}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("volunteer.aboutTitle")}</h2>
        <div className={formStyles.field}>
          <label className={formStyles.label} htmlFor="volunteer-name">
            {t("volunteer.name")}
          </label>
          <input
            id="volunteer-name"
            data-testid="volunteer-name"
            className={formStyles.input}
            maxLength={80}
            value={fullName}
            aria-invalid={errors.fullName ? true : undefined}
            onChange={(e) => setFullName(e.target.value)}
          />
          {errors.fullName ? <p className={formStyles.fieldError}>{errors.fullName}</p> : null}
        </div>
        <div className={formStyles.field}>
          <label className={formStyles.label} htmlFor="volunteer-phone">
            {t("volunteer.phone")}
          </label>
          <input
            id="volunteer-phone"
            data-testid="volunteer-phone"
            className={formStyles.input}
            type="tel"
            inputMode="tel"
            maxLength={20}
            placeholder="+855 12 345 678"
            value={phone}
            aria-invalid={errors.phone ? true : undefined}
            onChange={(e) => setPhone(e.target.value)}
          />
          {errors.phone ? <p className={formStyles.fieldError}>{errors.phone}</p> : null}
        </div>
        <div className={formStyles.field}>
          <label className={formStyles.label} htmlFor="volunteer-size">
            {t("volunteer.tshirt")}
          </label>
          <select id="volunteer-size" className={formStyles.input} value={tshirtSize} onChange={(e) => setTshirtSize(e.target.value)}>
            <option value="">{t("volunteer.tshirtNone")}</option>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className={formStyles.field}>
          <label className={formStyles.label} htmlFor="volunteer-note">
            {t("volunteer.noteLabel")}
          </label>
          <textarea
            id="volunteer-note"
            className={styles.textarea}
            rows={3}
            maxLength={500}
            placeholder={t("volunteer.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("volunteer.conductTitle")}</h2>
        <p className={styles.conduct}>{t("volunteer.conductText")}</p>
        {[
          { id: "conduct", checked: conduct, set: setConduct, label: t("volunteer.agreeConduct") },
          { id: "media", checked: media, set: setMedia, label: t("volunteer.agreeMedia"), optional: true },
          { id: "seats", checked: seats, set: setSeats, label: t("volunteer.agreeSeats") },
        ].map((item) => (
          <label key={item.id} className={formStyles.consentItem}>
            <input
              type="checkbox"
              checked={item.checked}
              onChange={(e) => item.set(e.target.checked)}
              data-testid={`volunteer-agree-${item.id}`}
            />
            <span className={formStyles.consentText}>
              <span>
                {item.label}
                {item.optional ? <span className={styles.optional}>{t("rules.optional")}</span> : null}
              </span>
            </span>
          </label>
        ))}
        {errors.conductAccepted ? <p className={formStyles.fieldError}>{errors.conductAccepted}</p> : null}
      </section>

      {formError ? (
        <p className={formStyles.formError} role="alert">
          {formError}
        </p>
      ) : null}
      <button type="submit" className={formStyles.submit} disabled={create.isPending} data-testid="volunteer-submit">
        {create.isPending ? t("volunteer.submitting") : t("volunteer.submit")}
      </button>
    </form>
  );
}
