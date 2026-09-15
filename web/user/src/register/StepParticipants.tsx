import { useTranslation } from "react-i18next";
import { MAX_PARTICIPANTS, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "./model";
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
