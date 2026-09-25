import { ApiError, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { useCreateFreeSignup, useRegistrationConsent, type RegistrationConsent } from "../free/queries";
import {
  FREE_SIGNUP_FIELDS,
  emptyFreeSignupValues,
  toFreeSignupRequest,
  validateFreeSignup,
  type FieldIssue,
  type FreeSignupField,
  type FreeSignupValues,
} from "../free/validate";
import { usePublicEvent } from "../queries";
import styles from "./FreeSignupPage.module.css";
import { NotFoundPage } from "./NotFoundPage";
import pageStyles from "./Page.module.css";

type PublicEvent = Schemas["PublicEvent"];
type FieldMessages = Partial<Record<FreeSignupField, string>>;

export function FreeSignupPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const event = usePublicEvent(slug);

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) => (
        <article>
          <h1 className={pageStyles.title}>{t("free.title")}</h1>
          <p className={pageStyles.meta}>{data.name}</p>
          {data.eventType === "FREE_ACTIVITY" && data.registrationOpen ? (
            <ConsentLoader event={data} />
          ) : (
            <p className={pageStyles.muted}>{t("free.closed")}</p>
          )}
        </article>
      )}
    </QueryState>
  );
}

function ConsentLoader({ event }: { event: PublicEvent }) {
  const consent = useRegistrationConsent();
  return <QueryState query={consent}>{(data) => <FreeSignupForm event={event} consent={data} />}</QueryState>;
}

function Field({ id, label, message, hint, children }: { id: string; label: string; message?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {message ? (
        <p className={styles.fieldError} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function FreeSignupForm({ event, consent }: { event: PublicEvent; consent: RegistrationConsent }) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const create = useCreateFreeSignup(event.slug);
  const [values, setValues] = useState<FreeSignupValues>(emptyFreeSignupValues);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [messages, setMessages] = useState<FieldMessages>({});

  const category = event.categories.find((c) => String(c.id) === values.categoryId);
  const allChecked = consent.items.every((item) => checked.has(item.key));

  if (create.data) {
    return (
      <section className={styles.done} data-testid="free-signup-done">
        <h2 className={styles.doneTitle}>{t("free.doneTitle")}</h2>
        <p>{t("free.doneBody", { signupNo: create.data.signupNo })}</p>
        <p className={styles.doneLinks}>
          <Link to="/orders">{t("free.doneOrders")}</Link>
          <Link to={`/events/${event.slug}`}>{t("free.doneBack")}</Link>
        </p>
      </section>
    );
  }

  const issueText = (issue: FieldIssue): string =>
    issue.key === "tooYoung" ? t("free.tooYoung", { minAge: issue.minAge }) : t(`free.${issue.key}`);

  const update = (field: keyof FreeSignupValues) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const toggle = (key: string) => (e: ChangeEvent<HTMLInputElement>) => {
    const on = e.target.checked;
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const issues = validateFreeSignup(values, category ? { minAge: category.minAge } : null, event.raceDate);
    const next: FieldMessages = {};
    for (const field of FREE_SIGNUP_FIELDS) {
      const issue = issues[field];
      if (issue) {
        next[field] = issueText(issue);
      }
    }
    setMessages(next);
    if (Object.keys(next).length > 0 || !allChecked) {
      return;
    }
    const body = toFreeSignupRequest(values, {
      version: consent.version,
      lang,
      checkedItems: consent.items.map((item) => item.key),
    });
    create.mutate(body, {
      onError: (error) => {
        if (error instanceof ApiError) {
          const server: FieldMessages = {};
          for (const field of FREE_SIGNUP_FIELDS) {
            const text = error.fields[field];
            if (text) {
              server[field] = text;
            }
          }
          setMessages(server);
        }
      },
    });
  };

  const errorCode = create.error instanceof ApiError ? create.error.code : undefined;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <Field
        id="free-category"
        label={t("free.category")}
        message={messages.categoryId}
        hint={category && category.minAge > 0 ? t("free.minAgeHint", { minAge: category.minAge }) : undefined}
      >
        <select
          id="free-category"
          data-testid="free-category"
          className={styles.input}
          value={values.categoryId}
          onChange={update("categoryId")}
          aria-invalid={messages.categoryId ? true : undefined}
        >
          <option value="">{t("free.chooseCategory")}</option>
          {event.categories.map((c) => (
            <option key={c.id} value={String(c.id)} disabled={c.soldOut}>
              {c.soldOut ? `${c.name} · ${t("free.soldOut")}` : c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field id="free-fullName" label={t("free.fullName")} message={messages.fullName}>
        <input
          id="free-fullName"
          data-testid="free-fullName"
          className={styles.input}
          autoComplete="name"
          value={values.fullName}
          onChange={update("fullName")}
          aria-invalid={messages.fullName ? true : undefined}
        />
      </Field>

      <Field id="free-phone" label={t("free.phone")} message={messages.phone} hint={t("free.phoneHint")}>
        <input
          id="free-phone"
          data-testid="free-phone"
          className={styles.input}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+85512345678"
          value={values.phone}
          onChange={update("phone")}
          aria-invalid={messages.phone ? true : undefined}
        />
      </Field>

      <Field id="free-emergencyName" label={t("free.emergencyName")} message={messages.emergencyName}>
        <input
          id="free-emergencyName"
          data-testid="free-emergencyName"
          className={styles.input}
          value={values.emergencyName}
          onChange={update("emergencyName")}
          aria-invalid={messages.emergencyName ? true : undefined}
        />
      </Field>

      <Field id="free-emergencyPhone" label={t("free.emergencyPhone")} message={messages.emergencyPhone}>
        <input
          id="free-emergencyPhone"
          data-testid="free-emergencyPhone"
          className={styles.input}
          type="tel"
          inputMode="tel"
          placeholder="+85512345678"
          value={values.emergencyPhone}
          onChange={update("emergencyPhone")}
          aria-invalid={messages.emergencyPhone ? true : undefined}
        />
      </Field>

      <Field id="free-gender" label={`${t("free.gender")} ${t("free.optional")}`} message={messages.gender}>
        <select id="free-gender" data-testid="free-gender" className={styles.input} value={values.gender} onChange={update("gender")}>
          <option value="">{t("free.genderUnset")}</option>
          <option value="M">{t("free.genderM")}</option>
          <option value="F">{t("free.genderF")}</option>
          <option value="X">{t("free.genderX")}</option>
        </select>
      </Field>

      <Field
        id="free-birthDate"
        label={category && category.minAge > 0 ? t("free.birthDate") : `${t("free.birthDate")} ${t("free.optional")}`}
        message={messages.birthDate}
      >
        <input
          id="free-birthDate"
          data-testid="free-birthDate"
          className={styles.input}
          type="date"
          value={values.birthDate}
          onChange={update("birthDate")}
          aria-invalid={messages.birthDate ? true : undefined}
        />
      </Field>

      <fieldset className={styles.consent}>
        <legend className={styles.label}>{t("free.consentTitle")}</legend>
        <details className={styles.fullText}>
          <summary>{t("free.consentFullText")}</summary>
          <p>{consent.fullText}</p>
        </details>
        {consent.items.map((item) => (
          <label key={item.key} className={styles.consentItem}>
            <input
              type="checkbox"
              data-testid={`consent-item-${item.key}`}
              checked={checked.has(item.key)}
              onChange={toggle(item.key)}
            />
            <span className={styles.consentText}>
              <strong>{item.title}</strong>
              {item.description ? <span className={styles.hint}>{item.description}</span> : null}
            </span>
          </label>
        ))}
        {!allChecked ? <p className={styles.hint}>{t("free.consentHint")}</p> : null}
      </fieldset>

      {create.error ? (
        <p className={styles.formError} role="alert" data-testid="form-error" data-code={errorCode}>
          {errorCode === "ALREADY_REGISTERED" ? t("free.alreadyRegistered") : create.error.message}
        </p>
      ) : null}

      <button type="submit" className={styles.submit} data-testid="free-submit" disabled={!allChecked || create.isPending}>
        {create.isPending ? t("free.submitting") : t("free.submit")}
      </button>
    </form>
  );
}
