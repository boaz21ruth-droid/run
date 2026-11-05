import { PROFILE_FIELDS, normalizeIdNo, validateProfileForm, type ProfileField } from "../profiles/validate";
import { formatDuration, parseDuration } from "../rules/duration";
import { ageOn, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "./model";

/** i18n key（user 命名空间）与插值参数 */
export interface FieldIssue {
  key: string;
  params?: Record<string, unknown>;
}

/** 键为 `participants[<i>].<field>`，与服务端 VALIDATION_FAILED 的字段路径一致 */
export type WizardIssues = Record<string, FieldIssue>;

export function participantField(index: number, field: string): string {
  return `participants[${index}].${field}`;
}

/** 从向导错误里取出第 i 位参赛人的资料字段错误，交给 ProfileFields 显示 */
export function participantFieldErrors(errors: Record<string, string>, index: number): Partial<Record<ProfileField, string>> {
  const picked: Partial<Record<ProfileField, string>> = {};
  for (const field of PROFILE_FIELDS) {
    const message = errors[participantField(index, field)];
    if (message) {
      picked[field] = message;
    }
  }
  return picked;
}

/** 第 1 步：组别已选且未满；同一常用参赛人不重复；常用参赛人比赛当天满组别最低年龄 */
export function validateParticipantsStep(
  participants: readonly ParticipantDraft[],
  event: PublicEvent,
  profiles: readonly RunnerProfile[],
): WizardIssues {
  const issues: WizardIssues = {};
  const chosen = new Set<number>();
  participants.forEach((draft, i) => {
    const category = event.categories.find((c) => c.id === draft.categoryId);
    if (!category) {
      issues[participantField(i, "categoryId")] = { key: "profiles.errors.required" };
    } else if (category.soldOut) {
      issues[participantField(i, "categoryId")] = { key: "register.errors.soldOut" };
    } else if (category.qualification) {
      Object.assign(issues, qualificationIssues(draft, category.qualification.maxTimeMs, i));
    }
    if (draft.profileId === null) {
      return;
    }
    if (chosen.has(draft.profileId)) {
      issues[participantField(i, "profileId")] = { key: "register.errors.duplicateProfile" };
      return;
    }
    chosen.add(draft.profileId);
    const saved = profiles.find((p) => p.id === draft.profileId);
    if (saved && category && ageOn(saved.birthDate, event.raceDate) < category.minAge) {
      issues[participantField(i, "profileId")] = { key: "register.errors.tooYoung", params: { minAge: category.minAge } };
    }
  });
  return issues;
}

/**
 * 第 2 步：新填资料的字段规则全部来自 profiles/validate；
 * 这里只加向导特有的两条——比赛当天满组别最低年龄、同一订单内证件号不重复。
 */
export function validateDetailsStep(participants: readonly ParticipantDraft[], event: PublicEvent, now: Date = new Date()): WizardIssues {
  const issues: WizardIssues = {};
  const idNos = new Set<string>();
  participants.forEach((draft, i) => {
    if (draft.profileId !== null) {
      return;
    }
    const found = validateProfileForm(draft.form, { now });
    for (const field of PROFILE_FIELDS) {
      const key = found[field];
      if (key) {
        issues[participantField(i, field)] = { key: `profiles.errors.${key}` };
      }
    }
    const category = event.categories.find((c) => c.id === draft.categoryId);
    if (!found.birthDate && category && ageOn(draft.form.birthDate, event.raceDate) < category.minAge) {
      issues[participantField(i, "birthDate")] = { key: "register.errors.tooYoung", params: { minAge: category.minAge } };
    }
    if (!found.idNo) {
      const idNo = normalizeIdNo(draft.form.idNo);
      if (idNos.has(idNo)) {
        issues[participantField(i, "idNo")] = { key: "register.errors.duplicateIdNo" };
      }
      idNos.add(idNo);
    }
  });
  return issues;
}

const PROOF_URL = /^https?:\/\/\S+$/;

/** 精英组的成绩证明：成绩格式与上限、来源、证明链接；字段路径与服务端一致 */
function qualificationIssues(draft: ParticipantDraft, maxTimeMs: number | null, i: number): WizardIssues {
  const issues: WizardIssues = {};
  const q = draft.qualification;
  const ms = parseDuration(q.time);
  if (q.time.trim() === "") {
    issues[participantField(i, "bestTimeMs")] = { key: "profiles.errors.required" };
  } else if (ms === null) {
    issues[participantField(i, "bestTimeMs")] = { key: "register.errors.timeFormat" };
  } else if (maxTimeMs !== null && ms > maxTimeMs) {
    issues[participantField(i, "bestTimeMs")] = { key: "register.errors.tooSlow", params: { max: formatDuration(maxTimeMs) } };
  }
  if (q.source.trim() === "") {
    issues[participantField(i, "proofSource")] = { key: "profiles.errors.required" };
  }
  if (q.proofUrl.trim() === "") {
    issues[participantField(i, "proofUrl")] = { key: "profiles.errors.required" };
  } else if (!PROOF_URL.test(q.proofUrl.trim())) {
    issues[participantField(i, "proofUrl")] = { key: "register.errors.urlFormat" };
  }
  return issues;
}
