import { ApiError, type Schemas } from "@werun/api-client";
import { App as AntdApp, Button, Form, Input, Modal, Select, Space } from "antd";
import { useTranslation } from "react-i18next";
import { useRejectProof } from "./queries";

type RejectCode = Schemas["RejectProofRequest"]["rejectCode"];

const REJECT_CODES: readonly RejectCode[] = [
  "NOT_RECEIVED",
  "AMOUNT_MISMATCH",
  "DUPLICATE_TXN",
  "UNREADABLE",
  "WRONG_ACCOUNT",
  "FRAUD",
  "OTHER",
];

interface RejectValues {
  rejectCode: RejectCode;
  rejectReason?: string;
}

export function RejectProofModal({ proofId, onClose }: { proofId: number; onClose: () => void }) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RejectValues>();
  const reject = useRejectProof(proofId);

  const onFinish = (values: RejectValues) => {
    const reason = values.rejectReason?.trim();
    reject.mutate(
      { rejectCode: values.rejectCode, rejectReason: reason ? reason : null },
      {
        onSuccess: () => {
          void message.success(t("proofs.reject.success"));
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError) {
            const fields = (["rejectCode", "rejectReason"] as const).flatMap((name) => {
              const text = error.fields[name];
              return text ? [{ name, errors: [text] }] : [];
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
    <Modal open title={t("proofs.reject.title")} onCancel={onClose} footer={null} maskClosable={false}>
      <Form<RejectValues> form={form} name="reject" layout="vertical" onFinish={onFinish} disabled={reject.isPending}>
        <Form.Item name="rejectCode" label={t("proofs.reject.code")} rules={[{ required: true, message: t("proofs.required") }]}>
          <Select options={REJECT_CODES.map((code) => ({ value: code, label: t(`proofs.rejectCode.${code}`) }))} />
        </Form.Item>
        <Form.Item
          name="rejectReason"
          label={t("proofs.reject.reason")}
          dependencies={["rejectCode"]}
          rules={[
            ({ getFieldValue }) => ({
              validator: (_, value: string | undefined) =>
                getFieldValue("rejectCode") === "OTHER" && !(value ?? "").trim()
                  ? Promise.reject(new Error(t("proofs.reject.reasonRequired")))
                  : Promise.resolve(),
            }),
            { max: 500, message: t("proofs.reject.reasonTooLong") },
          ]}
        >
          <Input.TextArea rows={3} maxLength={500} showCount />
        </Form.Item>
        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{t("common:action.back")}</Button>
          <Button type="primary" danger htmlType="submit" data-testid="proof-reject-submit" loading={reject.isPending}>
            {t("proofs.reject.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
