import type { Schemas } from "@werun/api-client";
import { emptyProfileForm, toProfileInput, type ProfileFormValues } from "../profiles/validate";
import { parseDuration } from "../rules/duration";

export const MAX_PARTICIPANTS = 10;

export type PublicEvent = Schemas["PublicEvent"];
export type RunnerProfile = Schemas["RunnerProfile"];

export interface ParticipantDraft {
  key: string;
  categoryId: number | null;
  /** 选了常用参赛人时为其 id，否则第 2 步填写 form */
  profileId: number | null;
  form: ProfileFormValues;
  saveAsProfile: boolean;
  /** 报精英组时自报的最好成绩（h:mm:ss）、成绩来源与证明链接；其他组别不提交 */
  qualification: QualificationDraft;
}

export interface QualificationDraft {
  time: string;
  source: string;
  proofUrl: string;
}

export const emptyQualification: QualificationDraft = { time: "", source: "", proofUrl: "" };

export function newParticipant(): ParticipantDraft {
  return {
    key: crypto.randomUUID(),
    categoryId: null,
    profileId: null,
    form: { ...emptyProfileForm },
    saveAsProfile: false,
    qualification: { ...emptyQualification },
  };
}

/** 选中的组别是不是要求资格证明的精英组 */
export function categoryOf(event: PublicEvent, draft: ParticipantDraft) {
  return event.categories.find((c) => c.id === draft.categoryId);
}

function dateParts(iso: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return [Number.NaN, Number.NaN, Number.NaN];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** 比赛当天周岁；2 月 29 日出生者在非闰年按 3 月 1 日满岁（与后端 pricing.AgeOn 一致）。Task 22 复用。 */
export function ageOn(birthDate: string, raceDate: string): number {
  const [by, birthMonth, birthDay] = dateParts(birthDate);
  const [ry, rm, rd] = dateParts(raceDate);
  let bm = birthMonth;
  let bd = birthDay;
  if (bm === 2 && bd === 29 && !isLeapYear(ry)) {
    bm = 3;
    bd = 1;
  }
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) {
    age -= 1;
  }
  return age;
}

/** RACE、报名开关打开且当前在报名时间内（为空表示不限）；服务端下单时仍会再校验 */
export function registrationAvailable(event: PublicEvent, now: Date = new Date()): boolean {
  if (event.eventType !== "RACE" || !event.registrationOpen) {
    return false;
  }
  const t = now.getTime();
  if (event.registrationOpensAt && Date.parse(event.registrationOpensAt) > t) {
    return false;
  }
  return !(event.registrationClosesAt && Date.parse(event.registrationClosesAt) <= t);
}

/** 下单请求里的一位参赛人；传入 event 时，报精英组的带上成绩证明 */
export function toOrderParticipant(draft: ParticipantDraft, event?: PublicEvent): Schemas["OrderParticipantInput"] {
  const categoryId = draft.categoryId ?? 0;
  const proof = event && categoryOf(event, draft)?.qualification ? toQualificationInput(draft.qualification) : null;
  const extra = proof ? { qualification: proof } : {};
  if (draft.profileId !== null) {
    return { categoryId, profileId: draft.profileId, ...extra };
  }
  // 规范化沿用 profiles/validate；下单资料没有 isSelf，证件号必填
  const input = toProfileInput(draft.form);
  return {
    categoryId,
    saveAsProfile: draft.saveAsProfile,
    profile: {
      fullName: input.fullName,
      gender: input.gender,
      birthDate: input.birthDate,
      nationality: input.nationality,
      idType: input.idType,
      idNo: input.idNo ?? "",
      phone: input.phone,
      ...(input.email ? { email: input.email } : {}),
      emergencyName: input.emergencyName,
      emergencyPhone: input.emergencyPhone,
      tshirtSize: input.tshirtSize,
    },
    ...extra,
  };
}

function toQualificationInput(q: QualificationDraft): Schemas["QualificationInput"] | null {
  const bestTimeMs = parseDuration(q.time);
  return bestTimeMs === null ? null : { bestTimeMs, source: q.source.trim(), proofUrl: q.proofUrl.trim() };
}

export function toQuoteParticipant(draft: ParticipantDraft, profiles: readonly RunnerProfile[]): Schemas["QuoteParticipantInput"] {
  const saved = draft.profileId === null ? undefined : profiles.find((p) => p.id === draft.profileId);
  return {
    categoryId: draft.categoryId ?? 0,
    nationality: saved ? saved.nationality : draft.form.nationality.trim().toUpperCase(),
    birthDate: saved ? saved.birthDate : draft.form.birthDate,
  };
}

export function participantName(draft: ParticipantDraft, profiles: readonly RunnerProfile[]): string {
  if (draft.profileId !== null) {
    return profiles.find((p) => p.id === draft.profileId)?.fullName ?? "";
  }
  return draft.form.fullName.trim();
}
