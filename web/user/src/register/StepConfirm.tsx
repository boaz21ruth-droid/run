import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { ORDERS_KEY, orderKey } from "../orders/api";
import { PROFILES_KEY } from "../queries";
import { createOrder, fetchQuote, quoteQueryKey, useRegistrationConsent } from "./api";
import { participantName, toOrderParticipant, toQuoteParticipant, type ParticipantDraft, type PublicEvent, type RunnerProfile } from "./model";
import type { SubmissionKey } from "./submissionKey";
import styles from "./Wizard.module.css";

interface StepConfirmProps {
  event: PublicEvent;
  participants: ParticipantDraft[];
  profiles: RunnerProfile[];
  submissionKey: SubmissionKey;
  /** 返回 true 表示向导已处理（例如回到前面的步骤） */
  onServerError: (error: ApiError) => boolean;
  onBack: () => void;
  onDone: (order: Schemas["OrderDetail"]) => void;
}

type CouponResult = { kind: "ok" | "error"; text: string };

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const details = Object.values(error.fields);
    return details.length > 0 ? `${error.message} ${details.join(" ")}` : error.message;
  }
  return fallback;
}

export function StepConfirm({ event, participants, profiles, submissionKey, onServerError, onBack, onDone }: StepConfirmProps) {
  const { t } = useTranslation("user");
  const lang = useLang();
  const api = useApi();
  const queryClient = useQueryClient();
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState("");
  const [couponResult, setCouponResult] = useState<CouponResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quoteParticipants = participants.map((p) => toQuoteParticipant(p, profiles));
  const quoteBody = (code: string): Schemas["QuoteRequest"] =>
    code ? { participants: quoteParticipants, couponCode: code } : { participants: quoteParticipants };
  const currentBody = quoteBody(appliedCoupon);
  const quote = useQuery({
    queryKey: quoteQueryKey(event.slug, currentBody),
    queryFn: () => fetchQuote(api, event.slug, currentBody),
  });
  const consent = useRegistrationConsent(lang);
  const consentItems = consent.data?.items ?? [];
  const allChecked = consentItems.length > 0 && consentItems.every((item) => checked[item.key]);

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (code === "") {
      setAppliedCoupon("");
      setCouponResult(null);
      return;
    }
    setApplying(true);
    try {
      const body = quoteBody(code);
      const data = await fetchQuote(api, event.slug, body);
      queryClient.setQueryData(quoteQueryKey(event.slug, body), data);
      setAppliedCoupon(code);
      setCouponResult({ kind: "ok", text: t("register.coupon.applied", { amount: formatUsd(data.couponDiscountCents) }) });
    } catch (err) {
      const text = err instanceof ApiError ? (err.fields.couponCode ?? err.message) : t("register.errors.network");
      setCouponResult({ kind: "error", text });
    } finally {
      setApplying(false);
    }
  }

  async function submit() {
    if (!consent.data || !allChecked) {
      return;
    }
    const payload: Schemas["CreateOrderRequest"] = {
      eventSlug: event.slug,
      ...(appliedCoupon ? { couponCode: appliedCoupon } : {}),
      // 同意书接口返回的语言可能是回退后的 en 或 zh，按接口说明原样提交
      consent: {
        version: consent.data.version,
        lang: consent.data.lang as Schemas["OrderConsentInput"]["lang"],
        checkedItems: consent.data.items.map((item) => item.key),
      },
      participants: participants.map(toOrderParticipant),
    };
    // 同一份请求体（网络失败后重试）沿用同一个键；订单内容变了才换新键
    const key = submissionKey.keyFor(JSON.stringify(payload));
    setSubmitting(true);
    setError(null);
    try {
      const order = await createOrder(api, key, payload);
      queryClient.setQueryData(orderKey(order.orderNo), order);
      void queryClient.invalidateQueries({ queryKey: ORDERS_KEY, exact: true });
      if (participants.some((p) => p.profileId === null && p.saveAsProfile)) {
        void queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
      }
      onDone(order);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setError(t("register.errors.network"));
        return;
      }
      if (err.code === "COUPON_INVALID" || err.code === "COUPON_EXHAUSTED") {
        setAppliedCoupon("");
        setCouponResult({ kind: "error", text: err.fields.couponCode ?? err.message });
        return;
      }
      if (!onServerError(err)) {
        setError(describeError(err, t("register.errors.network")));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("register.quote.title")}</h2>
        {quote.isPending ? (
          <p className={styles.hint}>{t("register.quote.loading")}</p>
        ) : quote.isError ? (
          <p className={styles.fieldError} role="alert" data-testid="quote-error">
            {describeError(quote.error, t("common:state.error"))}
          </p>
        ) : (
          <dl className={styles.amounts}>
            {quote.data.participants.map((p, i) => {
              const draft = participants[i];
              return (
                <div key={draft?.key ?? i} className={styles.amountRow}>
                  <dt>{draft ? participantName(draft, profiles) : ""}</dt>
                  <dd>{formatUsd(p.listPriceCents)}</dd>
                </div>
              );
            })}
            <div className={styles.amountRow}>
              <dt>{t("register.quote.listAmount")}</dt>
              <dd data-testid="quote-list-amount">{formatUsd(quote.data.listAmountCents)}</dd>
            </div>
            <div className={styles.amountRow}>
              <dt>{t("register.quote.discount")}</dt>
              <dd data-testid="quote-discount">{formatUsd(-quote.data.couponDiscountCents)}</dd>
            </div>
            <div className={styles.total}>
              <dt>{t("register.quote.amount")}</dt>
              <dd data-testid="quote-amount">{formatUsd(quote.data.amountCents)}</dd>
            </div>
          </dl>
        )}
        {/* 预览不选识别分，下单后的应付还会少 1–50 美分 */}
        <p className={styles.hint}>{t("register.quote.identNote")}</p>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="coupon-input">
            {t("register.coupon.label")}
          </label>
          <div className={styles.couponRow}>
            <input
              id="coupon-input"
              data-testid="coupon-input"
              className={styles.input}
              type="text"
              autoCapitalize="characters"
              maxLength={64}
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value)}
            />
            <button type="button" className={styles.secondary} data-testid="coupon-apply" disabled={applying} onClick={() => void applyCoupon()}>
              {t("register.coupon.apply")}
            </button>
          </div>
          {couponResult ? (
            <span
              data-testid="coupon-result"
              data-kind={couponResult.kind}
              className={couponResult.kind === "ok" ? styles.couponOk : styles.fieldError}
              role={couponResult.kind === "error" ? "alert" : "status"}
            >
              {couponResult.text}
            </span>
          ) : null}
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t("register.consent.title")}</h2>
        {consent.isPending ? (
          <p className={styles.hint}>{t("register.consent.loading")}</p>
        ) : consent.isError ? (
          <p className={styles.fieldError} role="alert">
            {describeError(consent.error, t("common:state.error"))}
          </p>
        ) : (
          <>
            <p className={styles.hint}>{t("register.consent.version", { version: consent.data.version })}</p>
            <div className={styles.consentText} tabIndex={0}>
              {consent.data.fullText}
            </div>
            {consent.data.items.map((item) => (
              <label key={item.key} className={styles.checkbox}>
                <input
                  type="checkbox"
                  data-testid={`consent-item-${item.key}`}
                  checked={checked[item.key] ?? false}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                />
                <span>
                  <strong>{item.title}</strong>
                  {item.description ? <span className={styles.hint}>{item.description}</span> : null}
                </span>
              </label>
            ))}
          </>
        )}
      </section>

      {error ? (
        <p className={styles.formError} role="alert" data-testid="form-error">
          {error}
        </p>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} data-testid="wizard-back" onClick={onBack}>
          {t("register.back")}
        </button>
        <button
          type="button"
          className={styles.primary}
          data-testid="order-submit"
          disabled={!allChecked || !quote.isSuccess || submitting}
          onClick={() => void submit()}
        >
          {submitting ? t("register.submitting") : t("register.submit")}
        </button>
      </div>
    </div>
  );
}
