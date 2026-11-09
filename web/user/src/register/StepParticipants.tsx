import { useTranslation } from "react-i18next";
import rules from "../rules/Rules.module.css";
import { MAX_PARTICIPANTS, categoryOf, type ParticipantDraft, type PublicEvent, type QualificationDraft, type RunnerProfile } from "./model";
import { participantField } from "./validate";
import styles from "./Wizard.module.css";

interface StepParticipantsProps {
  event: PublicEvent;
  participants: ParticipantDraft[];
  profiles: RunnerProfile[];
  errors: Record<string, string>;
  onChange: (index: number, patch: Partial<ParticipantDraft>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

const toId = (value: string) => (value === "" ? null : Number(value));

export function StepParticipants({ event, participants, profiles, errors, onChange, onAdd, onRemove }: StepParticipantsProps) {
  const { t } = useTranslation("user");

  return (
    <div className={styles.stack}>
      <p className={rules.noAccount} data-testid="register-no-account">
        {t("register.noAccount")}
      </p>
      {participants.map((draft, i) => {
        const categoryError = errors[participantField(i, "categoryId")];
        const profileError = errors[participantField(i, "profileId")];
        return (
          <fieldset key={draft.key} className={styles.card}>
            <legend className={styles.legend}>{t("register.participant", { n: i + 1 })}</legend>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`participant-${i}-category`}>
                {t("register.category")}
              </label>
              <select
                id={`participant-${i}-category`}
                data-testid={`participant-${i}-category`}
                className={styles.input}
                value={draft.categoryId ?? ""}
                aria-invalid={categoryError ? true : undefined}
                onChange={(e) => onChange(i, { categoryId: toId(e.target.value) })}
              >
                <option value="">{t("register.chooseCategory")}</option>
                {event.categories.map((category) => (
                  <option key={category.id} value={category.id} disabled={category.soldOut}>
                    {category.soldOut ? t("register.soldOutOption", { name: category.name }) : category.name}
                  </option>
                ))}
              </select>
              {categoryError ? (
                <span className={styles.fieldError} data-testid={`participant-${i}-category-error`}>
                  {categoryError}
                </span>
              ) : null}
            </div>
            <QualificationFields
              event={event}
              draft={draft}
              index={i}
              errors={errors}
              onChange={(patch) => onChange(i, { qualification: { ...draft.qualification, ...patch } })}
            />
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`participant-${i}-profile`}>
                {t("register.profile")}
              </label>
              <select
                id={`participant-${i}-profile`}
                data-testid={`participant-${i}-profile`}
                className={styles.input}
                value={draft.profileId ?? ""}
                aria-invalid={profileError ? true : undefined}
                onChange={(e) => onChange(i, { profileId: toId(e.target.value) })}
              >
                <option value="">{t("register.newProfile")}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {t("register.savedProfile", { name: profile.fullName, idNo: profile.idNoMasked })}
                  </option>
                ))}
              </select>
              {profileError ? (
                <span className={styles.fieldError} data-testid={`participant-${i}-profile-error`}>
                  {profileError}
                </span>
              ) : null}
            </div>
            {participants.length > 1 ? (
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} data-testid={`participant-${i}-remove`} onClick={() => onRemove(i)}>
                  {t("register.removeParticipant")}
                </button>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      {participants.length < MAX_PARTICIPANTS ? (
        <button type="button" className={styles.secondary} data-testid="participant-add" onClick={onAdd}>
          {t("register.addParticipant")}
        </button>
      ) : null}
    </div>
  );
}

interface QualificationFieldsProps {
  event: PublicEvent;
  draft: ParticipantDraft;
  index: number;
  errors: Record<string, string>;
  onChange: (patch: Partial<QualificationDraft>) => void;
}

/** 选了精英组时填最好成绩与证明（设计稿第 03 屏）；核验不通过转到公开组，报名仍然有效 */
function QualificationFields({ event, draft, index, errors, onChange }: QualificationFieldsProps) {
  const { t } = useTranslation("user");
  const category = categoryOf(event, draft);
  const qualification = category?.qualification;
  if (!qualification) {
    return null;
  }
  const fallback = event.categories.find((c) => c.id === qualification.fallbackCategoryId)?.name ?? "";
  const id = (field: string) => `participant-${index}-${field}`;
  const fields = [
    { name: "bestTimeMs", key: "time", label: t("register.qualify.time"), placeholder: "1:41:20", inputMode: "numeric" as const },
    { name: "proofSource", key: "source", label: t("register.qualify.source"), placeholder: t("register.qualify.sourcePlaceholder") },
  ] as const;
  const urlError = errors[participantField(index, "proofUrl")];
  return (
    <div className={rules.qualify} data-testid={`participant-${index}-qualify`}>
      <p className={rules.qualifyRule}>
        <strong>{qualification.rule}</strong> {t("register.qualify.fallback", { category: fallback })}
      </p>
      <div className={rules.qualifyRow}>
        {fields.map((f) => {
          const error = errors[participantField(index, f.name)];
          return (
            <div key={f.name} className={styles.field}>
              <label className={styles.label} htmlFor={id(f.name)}>
                {f.label}
              </label>
              <input
                id={id(f.name)}
                data-testid={id(f.name)}
                className={styles.input}
                maxLength={f.key === "time" ? 8 : 100}
                placeholder={f.placeholder}
                inputMode={"inputMode" in f ? f.inputMode : undefined}
                value={draft.qualification[f.key]}
                aria-invalid={error ? true : undefined}
                onChange={(e) => onChange({ [f.key]: e.target.value })}
              />
              {error ? <span className={styles.fieldError}>{error}</span> : null}
            </div>
          );
        })}
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id("proofUrl")}>
          {t("register.qualify.proofUrl")}
        </label>
        <input
          id={id("proofUrl")}
          data-testid={id("proofUrl")}
          className={styles.input}
          type="url"
          inputMode="url"
          maxLength={300}
          placeholder="https://"
          value={draft.qualification.proofUrl}
          aria-invalid={urlError ? true : undefined}
          onChange={(e) => onChange({ proofUrl: e.target.value })}
        />
        <span className={styles.hint}>{t("register.qualify.proofHint")}</span>
        {urlError ? <span className={styles.fieldError}>{urlError}</span> : null}
      </div>
    </div>
  );
}
