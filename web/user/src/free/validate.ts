import type { Schemas } from "@werun/api-client";
import { GENDERS, normalizePhone } from "../profiles/validate";
import { ageOn } from "../register/model";

export { ageOn, normalizePhone };

export type FreeSignupField = "categoryId" | "fullName" | "phone" | "emergencyName" | "emergencyPhone" | "gender" | "birthDate";

export const FREE_SIGNUP_FIELDS: readonly FreeSignupField[] = [
  "categoryId",
  "fullName",
  "phone",
  "emergencyName",
  "emergencyPhone",
  "gender",
  "birthDate",
];

export interface FreeSignupValues {
  categoryId: string;
  fullName: string;
  phone: string;
  emergencyName: string;
  emergencyPhone: string;
  /** "" | "M" | "F" | "X" */
  gender: string;
  /** "" 或 YYYY-MM-DD */
  birthDate: string;
}

export const emptyFreeSignupValues: FreeSignupValues = {
  categoryId: "",
  fullName: "",
  phone: "",
  emergencyName: "",
  emergencyPhone: "",
  gender: "",
  birthDate: "",
};

export type FieldIssue = { key: "required" } | { key: "phoneInvalid" } | { key: "tooYoung"; minAge: number };
export type FreeSignupIssues = Partial<Record<FreeSignupField, FieldIssue>>;

const E164 = /^\+[1-9]\d{7,14}$/;
type Gender = (typeof GENDERS)[number];

export function validateFreeSignup(values: FreeSignupValues, category: { minAge: number } | null, raceDate: string): FreeSignupIssues {
  const issues: FreeSignupIssues = {};
  if (values.categoryId === "" || category === null) {
    issues.categoryId = { key: "required" };
  }
  if (values.fullName.trim() === "") {
    issues.fullName = { key: "required" };
  }
  for (const field of ["phone", "emergencyPhone"] as const) {
    const phone = normalizePhone(values[field]);
    if (phone === "") {
      issues[field] = { key: "required" };
    } else if (!E164.test(phone)) {
      issues[field] = { key: "phoneInvalid" };
    }
  }
  if (values.emergencyName.trim() === "") {
    issues.emergencyName = { key: "required" };
  }
  if (category !== null && category.minAge > 0) {
    if (values.birthDate === "") {
      issues.birthDate = { key: "required" };
    } else if (ageOn(values.birthDate, raceDate) < category.minAge) {
      issues.birthDate = { key: "tooYoung", minAge: category.minAge };
    }
  }
  return issues;
}

function isGender(value: string): value is Gender {
  return (GENDERS as readonly string[]).includes(value);
}

export function toFreeSignupRequest(
  values: FreeSignupValues,
  consents: Schemas["FreeSignupConsent"],
): Schemas["FreeSignupRequest"] {
  const body: Schemas["FreeSignupRequest"] = {
    categoryId: Number(values.categoryId),
    fullName: values.fullName.trim(),
    phone: normalizePhone(values.phone),
    emergencyName: values.emergencyName.trim(),
    emergencyPhone: normalizePhone(values.emergencyPhone),
    consents,
  };
  if (isGender(values.gender)) {
    body.gender = values.gender;
  }
  if (values.birthDate !== "") {
    body.birthDate = values.birthDate;
  }
  return body;
}
