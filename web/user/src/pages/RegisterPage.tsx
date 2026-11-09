import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type Schemas } from "@werun/api-client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { emptyProfileForm, type ProfileFormValues } from "../profiles/validate";
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
/** 精英组成绩证明的字段在第 1 步填写 */
const QUALIFY_FIELDS = new Set(["bestTimeMs", "proofSource", "proofUrl"]);

/** 步骤放在 ?step=1..3（第 1 步不带参数），浏览器后退在步骤间移动 */
function parseStep(params: URLSearchParams): Step {
  const n = Number(params.get("step"));
  return n === 2 ? 1 : n === 3 ? 2 : 0;
}

/** 本向导推入的历史记录带的 state：wizard 区分是不是这次挂载的向导，from 是推入前所在的步骤 */
interface WizardHistoryState {
  wizard: string;
  from: Step;
}

function wizardState(value: unknown): WizardHistoryState | null {
  return value !== null && typeof value === "object" && "wizard" in value && "from" in value ? (value as WizardHistoryState) : null;
}

/** 有没有填过参赛人数据：用于离开报名页前确认 */
export function hasDraftData(participants: ParticipantDraft[]): boolean {
  if (participants.length > 1) {
    return true;
  }
  return participants.some(
    (p) =>
      p.categoryId !== null ||
      p.profileId !== null ||
      p.saveAsProfile ||
      Object.values(p.qualification).some((v) => v !== "") ||
      (Object.keys(emptyProfileForm) as (keyof ProfileFormValues)[]).some((field) => p.form[field] !== emptyProfileForm[field]),
  );
}

export function RegisterPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  // 切换语言时沿用已加载的赛事，向导不卸载；新语言加载完后标题与组别名自动更新
  const event = usePublicEvent(slug, { keepDataOnLanguageChange: true });
  const profiles = useProfiles();

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) =>
        registrationAvailable(data) ? (
          <QueryState query={profiles}>
            {/* 换了赛事（slug 变化）时重新开始，不带上一场的草稿与幂等键 */}
            {(items) => <RegisterWizard key={data.slug} event={data} profiles={items} />}
          </QueryState>
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
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [wizardId] = useState(() => crypto.randomUUID());
  const historyState = wizardState(location.state);
  // 刷新或从外部带 ?step= 打开时草稿不在了：只认本次向导自己推入的步骤，否则从第 1 步开始
  const ownsEntry = historyState?.wizard === wizardId;
  const step: Step = ownsEntry ? parseStep(searchParams) : 0;
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => [newParticipant()]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function update(index: number, patch: Partial<ParticipantDraft>) {
    setParticipants((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function updateForm(index: number, patch: Partial<ProfileFormValues>) {
    setParticipants((prev) => prev.map((p, i) => (i === index ? { ...p, form: { ...p.form, ...patch } } : p)));
  }

  // 地址带了不属于本向导的 step 参数时去掉它，地址与界面一致
  useEffect(() => {
    if (!ownsEntry && searchParams.has("step")) {
      const next = new URLSearchParams(searchParams);
      next.delete("step");
      setSearchParams(next, { replace: true });
    }
  }, [ownsEntry, searchParams, setSearchParams]);

  /**
   * 切换步骤：前进推入一条历史；后退到上一条历史正好是的那一步时直接 history.back，
   * 否则（如售罄从确认页跳回第 1 步）替换当前记录，避免历史里出现重复步骤。
   */
  function setStep(next: Step) {
    if (next === step) {
      return;
    }
    if (next < step && ownsEntry && historyState?.from === next) {
      navigate(-1);
      return;
    }
    const params = new URLSearchParams(searchParams);
    if (next === 0) {
      params.delete("step");
    } else {
      params.set("step", String(next + 1));
    }
    const state: WizardHistoryState = { wizard: wizardId, from: next > step ? step : (historyState?.from ?? 0) };
    setSearchParams(params, { replace: next < step, state });
  }

  function goTo(next: Step) {
    setFieldErrors({});
    setFormError(null);
    setStep(next);
  }

  // 填过参赛人资料后离开报名页（换到别的路径）先确认；同页换步骤不拦截，下单成功跳转也不拦截
  const leaving = useRef(false);
  const dirty = hasDraftData(participants);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

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
      if (name === "categoryId" || QUALIFY_FIELDS.has(name)) {
        mapped[participantField(index, name)] = message;
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
    leaving.current = true;
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
      {blocker.state === "blocked" ? (
        <div className={wizard.leaveConfirm} role="alertdialog" aria-labelledby="register-leave-title" aria-describedby="register-leave-body" data-testid="leave-confirm">
          <p id="register-leave-title" className={wizard.leaveTitle}>
            {t("registerLeave.title")}
          </p>
          <p id="register-leave-body">{t("registerLeave.body")}</p>
          <div className={wizard.actions}>
            <button type="button" className={wizard.secondary} data-testid="leave-stay" autoFocus onClick={() => blocker.reset()}>
              {t("registerLeave.stay")}
            </button>
            <button type="button" className={wizard.primary} data-testid="leave-confirm-leave" onClick={() => blocker.proceed()}>
              {t("registerLeave.leave")}
            </button>
          </div>
        </div>
      ) : null}
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
