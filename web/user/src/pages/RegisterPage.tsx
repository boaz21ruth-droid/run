import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type Schemas } from "@werun/api-client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import type { ProfileFormValues } from "../profiles/validate";
import { useProfiles, usePublicEvent } from "../queries";
import { QUOTE_KEY } from "../register/api";
import { newParticipant, registrationAvailable, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "../register/model";
import { StepConfirm } from "../register/StepConfirm";
import { StepDetails } from "../register/StepDetails";
import { StepParticipants } from "../register/StepParticipants";
import { SubmissionKey } from "../register/submissionKey";
import { participantField, validateDetailsStep, validateParticipantsStep, type WizardIssues } from "../register/validate";
import wizard from "../register/Wizard.module.css";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

const STEP_KEYS = ["participants", "details", "confirm"] as const;
type Step = 0 | 1 | 2;
const PARTICIPANT_FIELD = /^participants\[(\d+)\]\.(\w+)$/;

export function RegisterPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const event = usePublicEvent(slug);
  const profiles = useProfiles();

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) =>
        registrationAvailable(data) ? (
          <QueryState query={profiles}>{(items) => <RegisterWizard event={data} profiles={items} />}</QueryState>
        ) : (
          <section>
            <h1 className={styles.title}>{data.name}</h1>
            <p className={styles.muted} data-testid="register-closed">
              {t("register.closed")}
            </p>
          </section>
        )
      }
    </QueryState>
  );
}

function RegisterWizard({ event, profiles }: { event: PublicEvent; profiles: RunnerProfile[] }) {
  const { t } = useTranslation("user");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submissionKey] = useState(() => new SubmissionKey());
  const [step, setStep] = useState<Step>(0);
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => [newParticipant()]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function update(index: number, patch: Partial<ParticipantDraft>) {
    setParticipants((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function updateForm(index: number, patch: Partial<ProfileFormValues>) {
    setParticipants((prev) => prev.map((p, i) => (i === index ? { ...p, form: { ...p.form, ...patch } } : p)));
  }

  function goTo(next: Step) {
    setFieldErrors({});
    setFormError(null);
    setStep(next);
  }

  function finishStep(issues: WizardIssues, next: Step) {
    const messages: Record<string, string> = {};
    for (const [field, issue] of Object.entries(issues)) {
      messages[field] = t(issue.key, issue.params ?? {});
    }
    if (Object.keys(messages).length > 0) {
      setFieldErrors(messages);
      setFormError(t("profiles.errors.form"));
      return;
    }
    goTo(next);
  }

  function handleServerError(error: ApiError): boolean {
    if (error.code === "CATEGORY_SOLD_OUT" || error.code === "PRICE_TIER_SOLD_OUT") {
      // 刷新组别余量；清掉算价缓存，回到确认页时重新算价
      void queryClient.invalidateQueries({ queryKey: ["event", event.slug] });
      queryClient.removeQueries({ queryKey: QUOTE_KEY });
      setFieldErrors({});
      setFormError(error.message);
      setStep(0);
      return true;
    }
    if (error.code === "REGISTRATION_CLOSED") {
      void queryClient.invalidateQueries({ queryKey: ["event", event.slug] });
      return false;
    }
    const mapped: Record<string, string> = {};
    let target: Step = 1;
    for (const [field, message] of Object.entries(error.fields)) {
      const match = PARTICIPANT_FIELD.exec(field);
      if (!match) {
        continue;
      }
      const index = Number(match[1]);
      const name = match[2] ?? "";
      const usesSavedProfile = (participants[index]?.profileId ?? null) !== null;
      if (name === "categoryId") {
        mapped[participantField(index, "categoryId")] = message;
        target = 0;
      } else if (name === "profileId" || usesSavedProfile) {
        // 常用参赛人的资料问题只能在第 1 步换人或去资料页修改
        mapped[participantField(index, "profileId")] = message;
        target = 0;
      } else {
        mapped[field] = message;
      }
    }
    if (Object.keys(mapped).length === 0) {
      return false;
    }
    setFieldErrors(mapped);
    setFormError(error.message);
    setStep(target);
    return true;
  }

  function handleDone(order: Schemas["OrderDetail"]) {
    // 付款页在 Task 18 加入
    navigate(order.status === "PENDING_PAYMENT" ? `/orders/${order.orderNo}/pay` : `/orders/${order.orderNo}`);
  }

  return (
    <section>
      <h1 className={styles.title}>{t("register.title", { event: event.name })}</h1>
      <ol className={wizard.stepper}>
        {STEP_KEYS.map((key, i) => (
          <li key={key} className={i === step ? wizard.stepActive : wizard.step} aria-current={i === step ? "step" : undefined}>
            {t(`register.steps.${key}`)}
          </li>
        ))}
      </ol>
      {formError && step !== 2 ? (
        <p className={wizard.formError} role="alert" data-testid="form-error">
          {formError}
        </p>
      ) : null}

      {step === 0 ? (
        <StepParticipants
          event={event}
          participants={participants}
          profiles={profiles}
          errors={fieldErrors}
          onChange={update}
          onAdd={() => setParticipants((prev) => [...prev, newParticipant()])}
          onRemove={(index) => setParticipants((prev) => prev.filter((_, i) => i !== index))}
        />
      ) : null}
      {step === 1 ? (
        <StepDetails
          event={event}
          participants={participants}
          profiles={profiles}
          errors={fieldErrors}
          onFormChange={updateForm}
          onSaveProfileChange={(index, saveAsProfile) => update(index, { saveAsProfile })}
        />
      ) : null}
      {step === 2 ? (
        <StepConfirm
          event={event}
          participants={participants}
          profiles={profiles}
          submissionKey={submissionKey}
          onServerError={handleServerError}
          onBack={() => goTo(1)}
          onDone={handleDone}
        />
      ) : null}

      {step < 2 ? (
        <div className={wizard.actions}>
          {step > 0 ? (
            <button type="button" className={wizard.secondary} data-testid="wizard-back" onClick={() => goTo(0)}>
              {t("register.back")}
            </button>
          ) : null}
          <button
            type="button"
            className={wizard.primary}
            data-testid="wizard-next"
            onClick={() =>
              step === 0
                ? finishStep(validateParticipantsStep(participants, event, profiles), 1)
                : finishStep(validateDetailsStep(participants, event), 2)
            }
          >
            {t("register.next")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
