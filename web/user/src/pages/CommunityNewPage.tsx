import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
import { isLang, useLang } from "@werun/i18n";
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useApi } from "../api";
import { COMMUNITY_KEY, useCommunityConsent } from "../community/api";
import styles from "../community/Community.module.css";
import { QueryState } from "../components/QueryState";
import { checkedKeys, requiredChecked } from "../rules/consent";
import formStyles from "./FreeSignupPage.module.css";
import pageStyles from "./Page.module.css";

type Tag = Schemas["CommunityTag"];
const TAGS: Tag[] = ["MORNING", "NIGHT", "LONG", "TRAIL", "TRAINING", "FAMILY", "CYCLING", "OTHER"];

interface Values {
  title: string;
  tag: Tag;
  startsAt: string;
  city: string;
  location: string;
  meetPoint: string;
  distanceText: string;
  capacity: string;
  feeNote: string;
  hostName: string;
  contactTelegram: string;
  contactPhone: string;
  contactVisibility: "JOINED" | "PUBLIC";
  body: string;
}

const empty: Values = {
  title: "",
  tag: "MORNING",
  startsAt: "",
  city: "Phnom Penh",
  location: "",
  meetPoint: "",
  distanceText: "",
  capacity: "10",
  feeNote: "",
  hostName: "",
  contactTelegram: "",
  contactPhone: "",
  contactVisibility: "JOINED",
  body: "",
};

/** 发布跑团活动：签署跑友活动免责声明；需要审核时提交后先进审核 */
export function CommunityNewPage() {
  const consent = useCommunityConsent();
  return <QueryState query={consent}>{(data) => <NewForm consent={data} />}</QueryState>;
}

function NewForm({ consent }: { consent: Schemas["ConsentVersion"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [v, setV] = useState<Values>(empty);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof Values>(key: K) => (value: Values[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const isChecked = (key: string) => checked.has(`${consent.version}:${key}`);

  const create = useMutation({
    mutationFn: async (body: Schemas["CreateCommunityActivity"]) => unwrap(await api.POST("/app/community/activities", { body })),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: COMMUNITY_KEY });
      void navigate(`/community/${data.id}`, { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fields);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const required = t("profiles.errors.required");
    for (const key of ["title", "location", "meetPoint", "body", "startsAt"] as const) {
      if (v[key].trim() === "") found[key] = required;
    }
    const capacity = Number(v.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) found.capacity = t("community.errors.capacity");
    if (!v.contactTelegram.trim() && !v.contactPhone.trim()) found.contactTelegram = t("community.errors.contact");
    if (!requiredChecked(consent.items, isChecked)) found.consent = t("community.errors.consent");
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const opt = (s: string) => (s.trim() ? s.trim() : undefined);
    create.mutate({
      title: v.title.trim(),
      tag: v.tag,
      startsAt: new Date(v.startsAt).toISOString(),
      city: opt(v.city),
      location: v.location.trim(),
      meetPoint: v.meetPoint.trim(),
      distanceText: opt(v.distanceText),
      capacity,
      feeNote: opt(v.feeNote),
      hostName: opt(v.hostName),
      contactTelegram: opt(v.contactTelegram),
      contactPhone: opt(v.contactPhone),
      contactVisibility: v.contactVisibility,
      body: v.body.trim(),
      consent: {
        version: consent.version,
        lang: (isLang(consent.lang) ? consent.lang : lang) as Schemas["OrderConsentInput"]["lang"],
        checkedItems: checkedKeys(consent.items, isChecked),
      },
    });
  }

  const field = (key: keyof Values, label: string, input: ReactNode, hint?: string) => (
    <div className={formStyles.field}>
      <label className={formStyles.label} htmlFor={`community-${key}`}>
        {label}
      </label>
      {input}
      {hint ? <span className={formStyles.hint}>{hint}</span> : null}
      {errors[key] ? <p className={formStyles.fieldError}>{errors[key]}</p> : null}
    </div>
  );
  const text = (key: keyof Values, max: number, extra: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      id={`community-${key}`}
      data-testid={`community-${key}`}
      className={formStyles.input}
      maxLength={max}
      value={v[key]}
      aria-invalid={errors[key] ? true : undefined}
      onChange={(e) => set(key)(e.target.value as never)}
      {...extra}
    />
  );
  const formError = create.error instanceof ApiError && Object.keys(create.error.fields).length === 0 ? create.error.message : null;

  return (
    <form className={styles.newForm} onSubmit={submit} noValidate>
      <h1 className={pageStyles.title}>{t("community.new.title")}</h1>
      <p className={pageStyles.muted}>{t("community.new.intro")}</p>
      {field("title", t("community.fields.title"), text("title", 30, { placeholder: t("community.new.titlePlaceholder") }))}
      <fieldset className={styles.tagPicker}>
        <legend className={formStyles.label}>{t("community.fields.tag")}</legend>
        {TAGS.map((tag) => (
          <label key={tag} className={v.tag === tag ? styles.chipOn : styles.chip}>
            <input type="radio" name="community-tag" value={tag} checked={v.tag === tag} onChange={() => set("tag")(tag)} />
            {t(`community.tags.${tag}`)}
          </label>
        ))}
      </fieldset>
      {field("startsAt", t("community.fields.time"), text("startsAt", 20, { type: "datetime-local" }))}
      <div className={styles.twoCol}>
        {field("city", t("community.fields.city"), text("city", 40))}
        {field("location", t("community.fields.location"), text("location", 80, { placeholder: t("community.new.locationPlaceholder") }))}
      </div>
      {field("meetPoint", t("community.fields.meetPoint"), text("meetPoint", 120, { placeholder: t("community.new.meetPlaceholder") }))}
      <div className={styles.twoCol}>
        {field("distanceText", t("community.fields.distance"), text("distanceText", 40, { placeholder: "8K · 6:00–6:30" }))}
        {field("capacity", t("community.fields.capacity"), text("capacity", 3, { inputMode: "numeric" }))}
      </div>
      <div className={styles.twoCol}>
        {field("feeNote", t("community.fields.fee"), text("feeNote", 40, { placeholder: t("community.new.feePlaceholder") }))}
        {field("hostName", t("community.fields.hostName"), text("hostName", 40, { placeholder: "BKK Runners" }))}
      </div>
      <div className={styles.twoCol}>
        {field("contactTelegram", t("community.fields.telegram"), text("contactTelegram", 33, { placeholder: "@username" }))}
        {field("contactPhone", t("community.fields.phone"), text("contactPhone", 20, { type: "tel", placeholder: "+855 12 345 678" }))}
      </div>
      <fieldset className={styles.tagPicker}>
        <legend className={formStyles.label}>{t("community.fields.contactVisibility")}</legend>
        {(["JOINED", "PUBLIC"] as const).map((vis) => (
          <label key={vis} className={v.contactVisibility === vis ? styles.chipOn : styles.chip}>
            <input
              type="radio"
              name="community-visibility"
              value={vis}
              checked={v.contactVisibility === vis}
              onChange={() => set("contactVisibility")(vis)}
            />
            {t(`community.visibility.${vis}`)}
          </label>
        ))}
      </fieldset>
      {field(
        "body",
        t("community.fields.body"),
        <textarea
          id="community-body"
          data-testid="community-body"
          className={styles.textarea}
          rows={4}
          maxLength={1000}
          value={v.body}
          aria-invalid={errors.body ? true : undefined}
          onChange={(e) => set("body")(e.target.value)}
        />,
      )}
      <fieldset className={formStyles.consent}>
        <legend className={formStyles.label}>{t("community.new.consentTitle")}</legend>
        <details className={formStyles.fullText}>
          <summary>{t("free.consentFullText")}</summary>
          <p>{consent.fullText}</p>
        </details>
        {consent.items.map((item) => (
          <label key={item.key} className={formStyles.consentItem}>
            <input
              type="checkbox"
              data-testid={`community-consent-${item.key}`}
              checked={isChecked(item.key)}
              onChange={(e) =>
                setChecked((prev) => {
                  const next = new Set(prev);
                  const key = `${consent.version}:${item.key}`;
                  if (e.target.checked) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
            />
            <span className={formStyles.consentText}>
              <strong>{item.title}</strong>
              {item.description ? <span className={formStyles.hint}>{item.description}</span> : null}
            </span>
          </label>
        ))}
        {errors.consent ? <p className={formStyles.fieldError}>{errors.consent}</p> : null}
      </fieldset>
      {formError ? (
        <p className={formStyles.formError} role="alert">
          {formError}
        </p>
      ) : null}
      <button type="submit" className={formStyles.submit} disabled={create.isPending} data-testid="community-submit">
        {create.isPending ? t("community.new.submitting") : t("community.new.submit")}
      </button>
    </form>
  );
}
