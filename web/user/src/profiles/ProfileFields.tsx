import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ProfileFields.module.css";
import { GENDERS, ID_TYPES, TSHIRT_SIZES, type ProfileField, type ProfileFormValues } from "./validate";

export interface ProfileFieldsProps {
  values: ProfileFormValues;
  /** 已翻译的字段错误文案 */
  errors: Partial<Record<ProfileField, string>>;
  onChange: (patch: Partial<ProfileFormValues>) => void;
  /** testid 前缀：常用参赛人页为 profile，报名向导第 2 步为 participant-<i> */
  testIdPrefix: string;
  /** 证件号下方的提示，编辑时说明留空保留原号 */
  idNoHint?: string;
  showIsSelf?: boolean;
}

/** 一位参赛人的资料字段，全部为原生表单元素，每个元素带 `<prefix>-<field>` testid。 */
export function ProfileFields({ values, errors, onChange, testIdPrefix, idNoHint, showIsSelf = false }: ProfileFieldsProps) {
  const { t } = useTranslation("user");
  const baseId = useId();
  const idFor = (name: string) => `${baseId}-${name}`;
  const set = (field: ProfileField, value: string) => onChange({ [field]: value } as Partial<ProfileFormValues>);

  const controlProps = (field: ProfileField) => ({
    id: idFor(field),
    name: field,
    "data-testid": `${testIdPrefix}-${field}`,
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? idFor(`${field}-error`) : undefined,
    className: styles.control,
  });

  const input = (field: ProfileField, extra: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input {...controlProps(field)} {...extra} value={values[field]} onChange={(event) => set(field, event.target.value)} />
  );

  const select = (field: ProfileField, options: readonly string[], label: (value: string) => string) => (
    <select {...controlProps(field)} value={values[field]} onChange={(event) => set(field, event.target.value)}>
      <option value="">{t("profiles.choose")}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {label(option)}
        </option>
      ))}
    </select>
  );

  const row = (field: ProfileField, control: ReactNode, hint?: string) => (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={idFor(field)}>
        {t(`profiles.fields.${field}`)}
      </label>
      {control}
      {hint && <p className={styles.hint}>{hint}</p>}
      {errors[field] && (
        <p id={idFor(`${field}-error`)} className={styles.error} data-testid={`${testIdPrefix}-${field}-error`}>
          {errors[field]}
        </p>
      )}
    </div>
  );

  return (
    <div className={styles.grid}>
      {row("fullName", input("fullName", { autoComplete: "name", maxLength: 100 }))}
      {row("gender", select("gender", GENDERS, (value) => t(`profiles.gender.${value}`)))}
      {row("birthDate", input("birthDate", { type: "date", min: "1900-01-01" }))}
      {row("nationality", input("nationality", { maxLength: 2, autoCapitalize: "characters" }), t("profiles.fields.nationalityHint"))}
      {row("idType", select("idType", ID_TYPES, (value) => t(`profiles.idType.${value}`)))}
      {row("idNo", input("idNo", { autoComplete: "off", maxLength: 32 }), idNoHint)}
      {row("phone", input("phone", { type: "tel", autoComplete: "tel", inputMode: "tel" }), t("profiles.fields.phoneHint"))}
      {row("email", input("email", { type: "email", autoComplete: "email" }))}
      {row("emergencyName", input("emergencyName", { maxLength: 100 }))}
      {row("emergencyPhone", input("emergencyPhone", { type: "tel", inputMode: "tel" }))}
      {row("tshirtSize", select("tshirtSize", TSHIRT_SIZES, (value) => value))}
      {showIsSelf && (
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            name="isSelf"
            data-testid={`${testIdPrefix}-isSelf`}
            checked={values.isSelf}
            onChange={(event) => onChange({ isSelf: event.target.checked })}
          />
          {t("profiles.fields.isSelf")}
        </label>
      )}
    </div>
  );
}
