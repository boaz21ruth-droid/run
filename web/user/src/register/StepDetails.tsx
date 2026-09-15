import { useTranslation } from "react-i18next";
import { ProfileFields } from "../profiles/ProfileFields";
import type { ProfileFormValues } from "../profiles/validate";
import type { ParticipantDraft, PublicEvent, RunnerProfile } from "./model";
import { participantField, participantFieldErrors } from "./validate";
import styles from "./Wizard.module.css";

interface StepDetailsProps {
  event: PublicEvent;
  participants: ParticipantDraft[];
  profiles: RunnerProfile[];
  errors: Record<string, string>;
  onFormChange: (index: number, patch: Partial<ProfileFormValues>) => void;
  onSaveProfileChange: (index: number, saveAsProfile: boolean) => void;
}

export function StepDetails({ event, participants, profiles, errors, onFormChange, onSaveProfileChange }: StepDetailsProps) {
  const { t } = useTranslation("user");

  return (
    <div className={styles.stack}>
      {participants.map((draft, i) => {
        const category = event.categories.find((c) => c.id === draft.categoryId);
        const heading = (
          <h2 className={styles.cardTitle}>
            {t("register.participant", { n: i + 1 })}
            {category ? <span className={styles.hint}> · {category.name}</span> : null}
          </h2>
        );

        if (draft.profileId !== null) {
          const saved = profiles.find((p) => p.id === draft.profileId);
          const profileError = errors[participantField(i, "profileId")];
          return (
            <section key={draft.key} className={styles.card} data-testid={`participant-${i}-summary`}>
              {heading}
              {saved ? <p>{t("register.savedProfile", { name: saved.fullName, idNo: saved.idNoMasked })}</p> : null}
              {profileError ? (
                <span className={styles.fieldError} data-testid={`participant-${i}-profile-error`}>
                  {profileError}
                </span>
              ) : null}
            </section>
          );
        }

        return (
          <section key={draft.key} className={styles.card}>
            {heading}
            <ProfileFields
              values={draft.form}
              errors={participantFieldErrors(errors, i)}
              onChange={(patch) => onFormChange(i, patch)}
              testIdPrefix={`participant-${i}`}
            />
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                data-testid={`participant-${i}-saveProfile`}
                checked={draft.saveAsProfile}
                onChange={(e) => onSaveProfileChange(i, e.target.checked)}
              />
              <span>{t("register.saveProfile")}</span>
            </label>
          </section>
        );
      })}
    </div>
  );
}
