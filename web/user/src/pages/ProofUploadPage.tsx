import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { useMyOrder } from "../orders/api";
import orders from "../orders/Orders.module.css";
import { PROOF_ACCEPT, centsToInput, validateProofForm, type ProofField } from "../pay/proofForm";
import { useSubmitProof } from "../pay/queries";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Pay.module.css";
import pageStyles from "./Page.module.css";

const PAYABLE_STATUSES = new Set<string>(["PENDING_PAYMENT", "PROOF_REJECTED"]);

/** 服务端字段名 → 表单字段 */
const SERVER_FIELDS: Record<string, ProofField> = {
  file: "file",
  bankTxnRef: "txnRef",
  declaredAmountCents: "amount",
  declaredPaidAt: "paidAt",
};

/** 需要专门提示的错误码；其余错误显示服务端返回的文案 */
const SERVER_ERROR_KEYS: Record<string, string> = {
  ORDER_EXPIRED: "proof.serverError.ORDER_EXPIRED",
  PROOF_TXN_REF_USED: "proof.serverError.PROOF_TXN_REF_USED",
  FILE_TOO_LARGE: "proof.serverError.FILE_TOO_LARGE",
  FILE_TYPE_NOT_ALLOWED: "proof.serverError.FILE_TYPE_NOT_ALLOWED",
  ORDER_STATE_CONFLICT: "proof.serverError.ORDER_STATE_CONFLICT",
};

type FieldMessages = Partial<Record<ProofField, string>>;

export function ProofUploadPage() {
  const { orderNo = "" } = useParams();
  const order = useMyOrder(orderNo);

  if (order.error instanceof ApiError && order.error.status === 404) {
    return <NotFoundPage />;
  }
  return <QueryState query={order}>{(data) => <ProofForm order={data} />}</QueryState>;
}

function ProofForm({ order }: { order: Schemas["OrderDetail"] }) {
  const { t } = useTranslation("user");
  const navigate = useNavigate();
  const submit = useSubmitProof(order.orderNo);
  const [file, setFile] = useState<File | null>(null);
  const [txnRef, setTxnRef] = useState("");
  const [amount, setAmount] = useState(() => centsToInput(order.amountCents));
  const [paidAt, setPaidAt] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldMessages>({});
  const [formError, setFormError] = useState<{ message: string; expired: boolean } | null>(null);

  if (!PAYABLE_STATUSES.has(order.status)) {
    return <Navigate to={`/orders/${order.orderNo}`} replace />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const result = validateProofForm({ file, txnRef, amount, paidAt });
    if (!result.ok) {
      setFieldErrors(Object.fromEntries(Object.entries(result.errors).map(([field, key]) => [field, t(key)])));
      return;
    }
    setFieldErrors({});
    submit.mutate(result.value, {
      onSuccess: () => {
        void navigate(`/orders/${order.orderNo}`, { replace: true });
      },
      onError: (error) => {
        if (!(error instanceof ApiError)) {
          setFormError({ message: error.message, expired: false });
          return;
        }
        const mapped: FieldMessages = {};
        for (const [serverField, text] of Object.entries(error.fields)) {
          const field = SERVER_FIELDS[serverField];
          if (field) {
            mapped[field] = text;
          }
        }
        setFieldErrors(mapped);
        const key = SERVER_ERROR_KEYS[error.code];
        setFormError({ message: key ? t(key) : error.message, expired: error.code === "ORDER_EXPIRED" });
      },
    });
  };

  return (
    <article className={styles.panel}>
      <h1 className={pageStyles.title}>{t("proof.title")}</h1>
      <p className={pageStyles.muted}>{t("proof.intro")}</p>
      <p className={styles.hint}>
        {t("pay.amount")}: <strong className={styles.mono}>{formatUsd(order.amountCents)}</strong> ·{" "}
        <span className={styles.mono}>{order.orderNo}</span>
      </p>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <label className={styles.field}>
          <span className={styles.label}>{t("proof.file")}</span>
          <input
            type="file"
            data-testid="proof-file-input"
            accept={PROOF_ACCEPT}
            aria-invalid={fieldErrors.file ? true : undefined}
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
          <span className={styles.help}>{t("proof.fileHelp")}</span>
          {fieldErrors.file ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.file}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("proof.txnRef")}</span>
          <input
            type="text"
            data-testid="proof-txn-ref"
            className={styles.input}
            value={txnRef}
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={128}
            aria-invalid={fieldErrors.txnRef ? true : undefined}
            onChange={(event) => setTxnRef(event.currentTarget.value)}
          />
          <span className={styles.help}>{t("proof.txnRefHelp")}</span>
          {fieldErrors.txnRef ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.txnRef}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("proof.amount")}</span>
          <input
            type="text"
            inputMode="decimal"
            data-testid="proof-amount"
            className={styles.input}
            value={amount}
            aria-invalid={fieldErrors.amount ? true : undefined}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
          {fieldErrors.amount ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.amount}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("proof.paidAt")}</span>
          <input
            type="datetime-local"
            data-testid="proof-paid-at"
            className={styles.input}
            value={paidAt}
            aria-invalid={fieldErrors.paidAt ? true : undefined}
            onChange={(event) => setPaidAt(event.currentTarget.value)}
          />
          {fieldErrors.paidAt ? (
            <span className={styles.fieldError} role="alert">
              {fieldErrors.paidAt}
            </span>
          ) : null}
        </label>

        {formError ? (
          <div data-testid="form-error" className={styles.formError} role="alert">
            <p>{formError.message}</p>
            {formError.expired ? (
              <Link to={`/events/${order.eventSlug}/register`} data-testid="proof-reregister">
                {t("proof.reregister")}
              </Link>
            ) : null}
          </div>
        ) : null}

        <button type="submit" data-testid="proof-submit" className={orders.primaryButton} disabled={submit.isPending}>
          {submit.isPending ? t("proof.submitting") : t("proof.submit")}
        </button>
      </form>
    </article>
  );
}
