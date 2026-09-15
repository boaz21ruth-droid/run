import { ApiError, type Schemas } from "@werun/api-client";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { QueryState } from "../components/QueryState";
import { ProfileFields } from "../profiles/ProfileFields";
import {
  PROFILE_FIELDS,
  emptyProfileForm,
  pickProfileFieldErrors,
  profileToForm,
  toProfileInput,
  validateProfileForm,
  type ProfileField,
  type ProfileFormValues,
} from "../profiles/validate";
import { useCreateProfile, useDeleteProfile, useProfiles, useUpdateProfile } from "../queries";
import pageStyles from "./Page.module.css";
import styles from "./ProfilesPage.module.css";

type Profile = Schemas["RunnerProfile"];
type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit"; profile: Profile };

export function ProfilesPage() {
  const { t } = useTranslation("user");
  const profiles = useProfiles();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  if (mode.kind !== "list") {
    const profile = mode.kind === "edit" ? mode.profile : null;
    return <ProfileEditor key={profile?.id ?? "new"} profile={profile} onDone={() => setMode({ kind: "list" })} />;
  }

  return (
    <section>
      <div className={styles.head}>
        <h1 className={pageStyles.title}>{t("profiles.title")}</h1>
        <button type="button" className={styles.primary} data-testid="profile-create" onClick={() => setMode({ kind: "create" })}>
          {t("profiles.create")}
        </button>
      </div>
      <QueryState query={profiles}>
        {(items) =>
          items.length === 0 ? (
            <p className={pageStyles.muted}>{t("profiles.empty")}</p>
          ) : (
            <ul className={styles.list}>
              {items.map((profile) => (
                <ProfileItem key={profile.id} profile={profile} onEdit={() => setMode({ kind: "edit", profile })} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}

function ProfileItem({ profile, onEdit }: { profile: Profile; onEdit: () => void }) {
  const { t } = useTranslation("user");
  const remove = useDeleteProfile();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className={styles.item} data-testid={`profile-item-${profile.id}`}>
      <div className={styles.itemHead}>
        <span className={styles.name}>{profile.fullName}</span>
        {profile.isSelf && <span className={styles.badge}>{t("profiles.self")}</span>}
      </div>
      <dl className={styles.meta}>
        <div>
          <dt>{t("profiles.idNoLabel")}</dt>
          <dd className={styles.mono}>{profile.idNoMasked}</dd>
        </div>
        <div>
          <dt>{t("profiles.phoneLabel")}</dt>
          <dd className={styles.mono}>{profile.phone}</dd>
        </div>
      </dl>
      {confirming ? (
        <div className={styles.confirm}>
          <p>{t("profiles.deleteConfirm", { name: profile.fullName })}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.danger}
              data-testid={`profile-delete-confirm-${profile.id}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(profile.id)}
            >
              {t("profiles.confirmDelete")}
            </button>
            <button
              type="button"
              className={styles.secondary}
              data-testid={`profile-delete-cancel-${profile.id}`}
              onClick={() => setConfirming(false)}
            >
              {t("profiles.cancel")}
            </button>
          </div>
          {remove.isError && (
            <p role="alert">{remove.error instanceof ApiError ? remove.error.message : t("profiles.errors.delete")}</p>
          )}
        </div>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} data-testid={`profile-edit-${profile.id}`} onClick={onEdit}>
            {t("profiles.edit")}
          </button>
          <button type="button" className={styles.secondary} data-testid={`profile-delete-${profile.id}`} onClick={() => setConfirming(true)}>
            {t("profiles.delete")}
          </button>
        </div>
      )}
    </li>
  );
}

function ProfileEditor({ profile, onDone }: { profile: Profile | null; onDone: () => void }) {
  const { t } = useTranslation("user");
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const [values, setValues] = useState<ProfileFormValues>(() => (profile ? profileToForm(profile) : emptyProfileForm));
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateProfileForm(values, { idNoOptional: profile !== null });
    const messages: Partial<Record<ProfileField, string>> = {};
    for (const field of PROFILE_FIELDS) {
      const key = found[field];
      if (key) {
        messages[field] = t(`profiles.errors.${key}`);
      }
    }
    setErrors(messages);
    if (Object.keys(messages).length > 0) {
      setFormError(t("profiles.errors.form"));
      return;
    }
    setFormError(null);

    const body = toProfileInput(values);
    try {
      if (profile) {
        await update.mutateAsync({ id: profile.id, body });
      } else {
        await create.mutateAsync(body);
      }
      onDone();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(pickProfileFieldErrors(error.fields));
        setFormError(error.message);
      } else {
        setFormError(t("profiles.errors.save"));
      }
    }
  };

  return (
    <section>
      <h1 className={pageStyles.title}>{t(profile ? "profiles.editTitle" : "profiles.createTitle")}</h1>
      <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
        {formError && (
          <p className={styles.formError} role="alert" data-testid="form-error">
            {formError}
          </p>
        )}
        <ProfileFields
          values={values}
          errors={errors}
          onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
          testIdPrefix="profile"
          idNoHint={profile ? t("profiles.idNoKeepHint", { masked: profile.idNoMasked }) : undefined}
          showIsSelf
        />
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} data-testid="profile-submit" disabled={saving}>
            {saving ? t("profiles.saving") : t("profiles.save")}
          </button>
          <button type="button" className={styles.secondary} data-testid="profile-cancel" onClick={onDone}>
            {t("profiles.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
