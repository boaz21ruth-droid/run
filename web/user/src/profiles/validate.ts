import type { Schemas } from "@werun/api-client";

export const GENDERS = ["M", "F", "X"] as const;
export const ID_TYPES = ["NATIONAL_ID", "PASSPORT", "OTHER"] as const;
export const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;

/** 表单里的原始输入，select 未选择时为空串 */
export interface ProfileFormValues {
  fullName: string;
  gender: string;
  birthDate: string;
  nationality: string;
  idType: string;
  idNo: string;
  phone: string;
  email: string;
  emergencyName: string;
  emergencyPhone: string;
  tshirtSize: string;
  isSelf: boolean;
}

export type ProfileField = Exclude<keyof ProfileFormValues, "isSelf">;
export type ProfileErrorKey = "required" | "invalid";

export const PROFILE_FIELDS: readonly ProfileField[] = [
  "fullName",
  "gender",
  "birthDate",
  "nationality",
  "idType",
  "idNo",
  "phone",
  "email",
  "emergencyName",
  "emergencyPhone",
  "tshirtSize",
];

export const emptyProfileForm: ProfileFormValues = {
  fullName: "",
  gender: "",
  birthDate: "",
  nationality: "",
  idType: "",
  idNo: "",
  phone: "",
  email: "",
  emergencyName: "",
  emergencyPhone: "",
  tshirtSize: "",
  isSelf: false,
};

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MIN_BIRTH_DATE = "1900-01-01";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NATIONALITY = /^[A-Z]{2}$/;
const ID_NO = /^[A-Z0-9]{4,32}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeIdNo(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function normalizePhone(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isIn(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

export interface ValidateOptions {
  /** 编辑已有资料时证件号可以留空（保留原号） */
  idNoOptional?: boolean;
  now?: Date;
}

export function validateProfileForm(values: ProfileFormValues, options: ValidateOptions = {}): Partial<Record<ProfileField, ProfileErrorKey>> {
  const errors: Partial<Record<ProfileField, ProfileErrorKey>> = {};
  const check = (field: ProfileField, value: string, valid: (v: string) => boolean) => {
    if (value === "") {
      errors[field] = "required";
    } else if (!valid(value)) {
      errors[field] = "invalid";
    }
  };
  const nameValid = (v: string) => [...v].length <= MAX_NAME_LENGTH;
  const today = localIsoDate(options.now ?? new Date());

  check("fullName", values.fullName.trim(), nameValid);
  check("gender", values.gender, (v) => isIn(GENDERS, v));
  check("birthDate", values.birthDate, (v) => ISO_DATE.test(v) && v >= MIN_BIRTH_DATE && v <= today);
  check("nationality", values.nationality.trim().toUpperCase(), (v) => NATIONALITY.test(v));
  check("idType", values.idType, (v) => isIn(ID_TYPES, v));
  const idNo = normalizeIdNo(values.idNo);
  if (idNo !== "" || !options.idNoOptional) {
    check("idNo", idNo, (v) => ID_NO.test(v));
  }
  check("phone", normalizePhone(values.phone), (v) => PHONE.test(v));
  const email = values.email.trim();
  if (email !== "" && (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email))) {
    errors.email = "invalid";
  }
  check("emergencyName", values.emergencyName.trim(), nameValid);
  check("emergencyPhone", normalizePhone(values.emergencyPhone), (v) => PHONE.test(v));
  check("tshirtSize", values.tshirtSize, (v) => isIn(TSHIRT_SIZES, v));
  return errors;
}

/** 转为接口请求体；调用前已通过 validateProfileForm，枚举字段可以直接断言类型。 */
export function toProfileInput(values: ProfileFormValues): Schemas["ProfileInput"] {
  const idNo = normalizeIdNo(values.idNo);
  const email = values.email.trim();
  return {
    fullName: values.fullName.trim(),
    gender: values.gender as Schemas["Gender"],
    birthDate: values.birthDate,
    nationality: values.nationality.trim().toUpperCase(),
    idType: values.idType as Schemas["IdType"],
    ...(idNo ? { idNo } : {}),
    phone: normalizePhone(values.phone),
    ...(email ? { email } : {}),
    emergencyName: values.emergencyName.trim(),
    emergencyPhone: normalizePhone(values.emergencyPhone),
    tshirtSize: values.tshirtSize as Schemas["TShirtSize"],
    isSelf: values.isSelf,
  };
}

/** 编辑时回填；接口不返回完整证件号，证件号留空表示保留。 */
export function profileToForm(profile: Schemas["RunnerProfile"]): ProfileFormValues {
  return {
    fullName: profile.fullName,
    gender: profile.gender,
    birthDate: profile.birthDate,
    nationality: profile.nationality,
    idType: profile.idType,
    idNo: "",
    phone: profile.phone,
    email: profile.email,
    emergencyName: profile.emergencyName,
    emergencyPhone: profile.emergencyPhone,
    tshirtSize: profile.tshirtSize,
    isSelf: profile.isSelf,
  };
}

/** 从 ApiError.fields（已翻译的文案）中挑出本表单的字段 */
export function pickProfileFieldErrors(fields: Record<string, string>): Partial<Record<ProfileField, string>> {
  const picked: Partial<Record<ProfileField, string>> = {};
  for (const field of PROFILE_FIELDS) {
    const message = fields[field];
    if (message) {
      picked[field] = message;
    }
  }
  return picked;
}
