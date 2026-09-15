import { ApiError, formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import { Alert, App as AntdApp, Button, DatePicker, Form, Input, Modal, Space } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";
import { centsToUsdInput } from "../orders/format";
import { useApproveProof } from "./queries";

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
  onClose: () => void;
}

export function ApproveProofModal({ proof, amountCents, onClose }: ApproveProofModalProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ApproveValues>();
  const approve = useApproveProof(proof.id);

  const receivedUsd = Form.useWatch("receivedUsd", form);
  const cents = parseUsdToCents((receivedUsd ?? "").trim());
  const tooLow = cents !== null && cents < amountCents;
  const overpaid = cents !== null && cents > amountCents ? cents - amountCents : 0;

  const onFinish = (values: ApproveValues) => {
    const received = parseUsdToCents(values.receivedUsd.trim());
    if (received === null || received < amountCents) {
      return;
    }
    const note = values.note?.trim();
    approve.mutate(
      { receivedAmountCents: received, receivedAt: values.receivedAt.toISOString(), note: note ? note : null },
      {
        onSuccess: () => {
          void message.success(t("proofs.approve.success"));
          onClose();
        },
        onError: (error) => {
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
          receivedAt: proof.declaredPaidAt ? dayjs(proof.declaredPaidAt) : dayjs(),
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
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t("proofs.approve.overpaid", { amount: formatUsd(overpaid) })}
          />
        ) : null}
        <Form.Item name="receivedAt" label={t("proofs.approve.receivedAt")} rules={[{ required: true, message: t("proofs.required") }]}>
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
            disabled={cents === null || tooLow}
            loading={approve.isPending}
          >
            {t("proofs.approve.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
