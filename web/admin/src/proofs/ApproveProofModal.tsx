import { ApiError, formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import { Alert, App as AntdApp, Button, Checkbox, DatePicker, Form, Input, Modal, Space } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { centsToUsdInput } from "../orders/format";
import { fromEventWallClock, toEventWallClock } from "../time/eventTime";
import { TimezoneHint } from "../time/TimezoneHint";
import { isReviewConflict, useApproveProof, useRefreshAfterConflict } from "./queries";

interface ApproveValues {
  receivedUsd: string;
  receivedAt: Dayjs;
  note?: string;
}

/** 服务端字段名 → 表单字段 */
const SERVER_FIELDS: [string, keyof ApproveValues][] = [
  ["receivedAmountCents", "receivedUsd"],
  ["receivedAt", "receivedAt"],
  ["note", "note"],
];

interface ApproveProofModalProps {
  proof: Schemas["Proof"];
  amountCents: number;
  /** 赛事时区（order.eventTimezone）：到账时间按它填写与回填 */
  timezone: string;
  onClose: () => void;
}

export function ApproveProofModal({ proof, amountCents, timezone, onClose }: ApproveProofModalProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ApproveValues>();
  const approve = useApproveProof(proof.id);
  const refreshAfterConflict = useRefreshAfterConflict();
  /** 勾选确认时的多付金额；金额再变化就需要重新确认 */
  const [confirmedOverpay, setConfirmedOverpay] = useState<number | null>(null);

  const receivedUsd = Form.useWatch("receivedUsd", form);
  const cents = parseUsdToCents((receivedUsd ?? "").trim());
  const tooLow = cents !== null && cents < amountCents;
  const overpaid = cents !== null && cents > amountCents ? cents - amountCents : 0;
  const overpayConfirmed = overpaid === 0 || confirmedOverpay === overpaid;

  const onFinish = (values: ApproveValues) => {
    const received = parseUsdToCents(values.receivedUsd.trim());
    if (received === null || received < amountCents) {
      return;
    }
    if (received > amountCents && confirmedOverpay !== received - amountCents) {
      return;
    }
    const note = values.note?.trim();
    approve.mutate(
      {
        receivedAmountCents: received,
        receivedAt: fromEventWallClock(values.receivedAt, timezone),
        note: note ? note : null,
      },
      {
        onSuccess: () => {
          void message.success(t("proofs.approve.success"));
          onClose();
        },
        onError: (error) => {
          if (isReviewConflict(error)) {
            void message.warning(t("proofs.conflict"));
            refreshAfterConflict();
            onClose();
            return;
          }
          if (error instanceof ApiError) {
            const fields = SERVER_FIELDS.flatMap(([server, local]) => {
              const text = error.fields[server];
              return text ? [{ name: local, errors: [text] }] : [];
            });
            if (fields.length > 0) {
              form.setFields(fields);
              return;
            }
          }
          void message.error(error.message);
        },
      },
    );
  };

  return (
    <Modal open title={t("proofs.approve.title")} onCancel={onClose} footer={null} maskClosable={false}>
      <Form<ApproveValues>
        form={form}
        name="approve"
        layout="vertical"
        onFinish={onFinish}
        disabled={approve.isPending}
        initialValues={{
          receivedUsd: centsToUsdInput(proof.declaredAmountCents),
          receivedAt: toEventWallClock(proof.declaredPaidAt ?? dayjs().toISOString(), timezone),
        }}
      >
        <Form.Item
          name="receivedUsd"
          label={t("proofs.approve.receivedUsd")}
          extra={t("orders.detail.amount") + " " + formatUsd(amountCents)}
          rules={[
            { required: true, message: t("proofs.required") },
            {
              validator: (_, value: string | undefined) =>
                parseUsdToCents((value ?? "").trim()) === null
                  ? Promise.reject(new Error(t("proofs.approve.invalidAmount")))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input prefix="$" inputMode="decimal" autoComplete="off" />
        </Form.Item>
        {tooLow ? (
          <Alert
            data-testid="proof-approve-too-low"
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message={t("proofs.approve.tooLow", { amount: formatUsd(amountCents) })}
          />
        ) : null}
        {overpaid > 0 ? (
          <Alert
            data-testid="proof-approve-overpaid"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t("proofs.approve.overpaid", { amount: formatUsd(overpaid) })}
            description={
              <Checkbox
                data-testid="proof-approve-overpay-confirm"
                checked={overpayConfirmed}
                onChange={(event) => setConfirmedOverpay(event.target.checked ? overpaid : null)}
              >
                {t("proofs.approve.confirmOverpay", { amount: formatUsd(overpaid) })}
              </Checkbox>
            }
          />
        ) : null}
        <Form.Item
          name="receivedAt"
          label={t("proofs.approve.receivedAt")}
          extra={<TimezoneHint tz={timezone} />}
          rules={[{ required: true, message: t("proofs.required") }]}
        >
          <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="note" label={t("proofs.approve.note")}>
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{t("common:action.back")}</Button>
          <Button
            type="primary"
            htmlType="submit"
            data-testid="proof-approve-submit"
            disabled={cents === null || tooLow || !overpayConfirmed}
            loading={approve.isPending}
          >
            {t("proofs.approve.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
