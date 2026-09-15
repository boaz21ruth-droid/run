import { parseUsdToCents } from "@werun/api-client";

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
export const PROOF_ACCEPT = "image/jpeg,image/png,image/webp";

const PROOF_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_TXN_REF = 4;
const MAX_TXN_REF = 64;

export interface ProofFormInput {
  file: File | null;
  txnRef: string;
  amount: string;
  /** datetime-local 的原值，如 "2026-09-14T10:30"；空串表示不填 */
  paidAt: string;
}

export interface ProofSubmission {
  file: File;
  bankTxnRef: string;
  declaredAmountCents: number;
  declaredPaidAt: string | null;
}

export type ProofField = "file" | "txnRef" | "amount" | "paidAt";

/** 值为 user 命名空间下的文案 key */
export type ProofFormErrors = Partial<Record<ProofField, string>>;

export type ProofValidation = { ok: true; value: ProofSubmission } | { ok: false; errors: ProofFormErrors };

/** 与服务端一致：去掉所有空白后转大写 */
export function normalizeTxnRef(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** 3999 → "39.99"；只用整数运算 */
export function centsToInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, "0")}`;
}

export function validateProofForm(input: ProofFormInput): ProofValidation {
  const errors: ProofFormErrors = {};

  if (!input.file) {
    errors.file = "proof.error.fileRequired";
  } else if (!PROOF_MIME_TYPES.has(input.file.type)) {
    errors.file = "proof.error.fileType";
  } else if (input.file.size > MAX_PROOF_BYTES) {
    errors.file = "proof.error.fileTooLarge";
  }

  const bankTxnRef = normalizeTxnRef(input.txnRef);
  const refLength = [...bankTxnRef].length;
  if (refLength < MIN_TXN_REF || refLength > MAX_TXN_REF) {
    errors.txnRef = "proof.error.txnRefLength";
  }

  const cents = parseUsdToCents(input.amount.trim());
  if (cents === null || cents <= 0) {
    errors.amount = "proof.error.amountInvalid";
  }

  let declaredPaidAt: string | null = null;
  if (input.paidAt.trim() !== "") {
    const date = new Date(input.paidAt);
    if (Number.isNaN(date.getTime())) {
      errors.paidAt = "proof.error.paidAtInvalid";
    } else {
      declaredPaidAt = date.toISOString();
    }
  }

  if (Object.keys(errors).length > 0 || !input.file || cents === null) {
    return { ok: false, errors };
  }
  return { ok: true, value: { file: input.file, bankTxnRef, declaredAmountCents: cents, declaredPaidAt } };
}

/** 文本字段在前、文件最后，服务端按顺序流式读取 */
export function toProofFormData(submission: ProofSubmission): FormData {
  const form = new FormData();
  form.append("bankTxnRef", submission.bankTxnRef);
  form.append("declaredAmountCents", String(submission.declaredAmountCents));
  if (submission.declaredPaidAt) {
    form.append("declaredPaidAt", submission.declaredPaidAt);
  }
  form.append("file", submission.file, submission.file.name);
  return form;
}
