import { PlusOutlined, UploadOutlined } from "@ant-design/icons";
import { ApiError, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import {
  Alert,
  App as AntdApp,
  Button,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
  type UploadFile,
} from "antd";
import { useState, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { PERM_PAYMENT_ACCOUNT_MANAGE, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { toNamePath } from "../events/eventForm";
import { pickText } from "../events/localize";
import { useAdminEvents } from "../events/queries";
import {
  emptyAccount,
  fromAccount,
  publicFileUrl,
  toAccountFormData,
  type PaymentAccountFormValues,
} from "../payments/accountForm";
import { usePaymentAccounts, useSavePaymentAccount } from "../payments/queries";

type PaymentAccount = Schemas["PaymentAccount"];
type AdminEvent = Schemas["AdminEvent"];

const PROVIDERS = ["ABA", "ACLEDA", "WING", "BAKONG", "OTHER"] as const;
const SCOPES = ["REGISTRATION", "MERCH", "ALL"] as const;

export function PaymentAccountsPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { data: me } = useMe();
  const accounts = usePaymentAccounts();
  const events = useAdminEvents();
  const canWrite = can(me?.permissions, PERM_PAYMENT_ACCOUNT_MANAGE, "write");
  const [editing, setEditing] = useState<{ account?: PaymentAccount } | null>(null);

  const eventLabel = (eventId: number | null): string => {
    if (eventId === null) {
      return t("paymentAccounts.global");
    }
    const found = events.data?.find((event) => event.id === eventId);
    return found ? pickText(found.name, lang) : `#${eventId}`;
  };

  const columns: TableProps<PaymentAccount>["columns"] = [
    {
      title: t("paymentAccounts.col.qr"),
      key: "qr",
      render: (_, account) => (
        <img
          src={publicFileUrl(account.qrFileId)}
          alt={account.name}
          width={48}
          height={48}
          style={{ objectFit: "contain", border: "1px solid var(--line)", borderRadius: 4 }}
        />
      ),
    },
    { title: t("paymentAccounts.col.name"), dataIndex: "name", key: "name" },
    {
      title: t("paymentAccounts.col.provider"),
      key: "provider",
      render: (_, account) => t(`paymentAccounts.provider.${account.provider}`),
    },
    { title: t("paymentAccounts.col.accountName"), dataIndex: "accountName", key: "accountName" },
    { title: t("paymentAccounts.col.accountNoMasked"), dataIndex: "accountNoMasked", key: "accountNoMasked" },
    {
      title: t("paymentAccounts.col.scope"),
      key: "scope",
      render: (_, account) => <Tag>{t(`paymentAccounts.scope.${account.scope}`)}</Tag>,
    },
    { title: t("paymentAccounts.col.event"), key: "event", render: (_, account) => eventLabel(account.eventId) },
    {
      title: t("paymentAccounts.col.status"),
      key: "status",
      render: (_, account) =>
        account.active ? (
          <Tag color="green">{t("paymentAccounts.active")}</Tag>
        ) : (
          <Tag>{t("paymentAccounts.inactive")}</Tag>
        ),
    },
    {
      title: t("paymentAccounts.col.actions"),
      key: "actions",
      render: (_, account) =>
        canWrite ? (
          <Button size="small" data-testid={`payment-account-edit-${account.id}`} onClick={() => setEditing({ account })}>
            {t("paymentAccounts.edit")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t("paymentAccounts.title")}
        </Typography.Title>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} data-testid="payment-account-create" onClick={() => setEditing({})}>
            {t("paymentAccounts.create")}
          </Button>
        ) : null}
      </Space>
      <Typography.Text type="secondary">{t("paymentAccounts.currencyNote")}</Typography.Text>
      {accounts.isError ? <Alert type="error" showIcon message={accounts.error.message} /> : null}
      <Table<PaymentAccount>
        rowKey="id"
        columns={columns}
        dataSource={accounts.data ?? []}
        loading={accounts.isPending}
        pagination={false}
        locale={{ emptyText: t("paymentAccounts.empty") }}
        scroll={{ x: 1100 }}
        onRow={(account) => ({ "data-testid": `payment-account-row-${account.id}` }) as HTMLAttributes<HTMLElement>}
      />
      {editing ? (
        <PaymentAccountModal account={editing.account} events={events.data ?? []} onClose={() => setEditing(null)} />
      ) : null}
    </Space>
  );
}

interface PaymentAccountModalProps {
  account?: PaymentAccount;
  events: AdminEvent[];
  onClose: () => void;
}

function PaymentAccountModal({ account, events, onClose }: PaymentAccountModalProps) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PaymentAccountFormValues>();
  const save = useSavePaymentAccount();
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [qrMissing, setQrMissing] = useState(false);
  const required = [{ required: true, message: t("form.required") }];

  const apiError = save.error instanceof ApiError ? save.error : null;
  const hasFieldErrors = apiError !== null && Object.keys(apiError.fields).length > 0;
  const bannerError = save.error && !hasFieldErrors ? save.error : null;
  const qrServerError = apiError?.fields.qr;

  const onFinish = (values: PaymentAccountFormValues) => {
    if (!account && !qrFile) {
      setQrMissing(true);
      return;
    }
    save.mutate(
      { id: account?.id, form: toAccountFormData(values, qrFile) },
      {
        onSuccess: () => {
          void message.success(t(account ? "paymentAccounts.updated" : "paymentAccounts.created"));
          onClose();
        },
        onError: (error) => {
          if (!(error instanceof ApiError)) {
            return;
          }
          const fieldEntries = Object.entries(error.fields).filter(([field]) => field !== "qr");
          if (fieldEntries.length > 0) {
            form.setFields(
              fieldEntries.map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
                typeof form.setFields
              >[0],
            );
          }
        },
      },
    );
  };

  const fileList: UploadFile[] = qrFile ? [{ uid: "qr", name: qrFile.name, status: "done" }] : [];
  const qrHelp = qrMissing
    ? t("paymentAccounts.form.qrRequired")
    : (qrServerError ?? t(account ? "paymentAccounts.form.qrKeepHelp" : "paymentAccounts.form.qrHelp"));

  return (
    <Modal
      open
      title={t(account ? "paymentAccounts.editTitle" : "paymentAccounts.createTitle")}
      onCancel={onClose}
      footer={null}
      width={720}
      maskClosable={false}
    >
      {bannerError ? <Alert type="error" showIcon message={bannerError.message} style={{ marginBottom: 16 }} /> : null}
      <Form<PaymentAccountFormValues>
        form={form}
        name="paymentAccount"
        layout="vertical"
        onFinish={onFinish}
        disabled={save.isPending}
        initialValues={account ? fromAccount(account) : emptyAccount()}
      >
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label={t("paymentAccounts.form.name")} extra={t("paymentAccounts.form.nameHelp")} rules={required}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="provider" label={t("paymentAccounts.form.provider")} rules={required}>
              <Select options={PROVIDERS.map((p) => ({ value: p, label: t(`paymentAccounts.provider.${p}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="accountName" label={t("paymentAccounts.form.accountName")} rules={required}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="accountNoMasked"
              label={t("paymentAccounts.form.accountNoMasked")}
              extra={t("paymentAccounts.form.accountNoMaskedHelp")}
              rules={required}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="scope" label={t("paymentAccounts.form.scope")} rules={required}>
              <Select options={SCOPES.map((s) => ({ value: s, label: t(`paymentAccounts.scope.${s}`) }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="eventId" label={t("paymentAccounts.form.eventId")} extra={t("paymentAccounts.form.eventIdHelp")}>
              <Select
                allowClear
                placeholder={t("paymentAccounts.global")}
                options={events.map((event) => ({ value: event.id, label: pickText(event.name, lang) }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={4}>
            <Form.Item name="active" label={t("paymentAccounts.form.active")} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          label={t("paymentAccounts.form.qr")}
          required={!account}
          validateStatus={qrMissing || qrServerError ? "error" : undefined}
          help={qrHelp}
        >
          <Space align="start">
            {account && !qrFile ? (
              <img
                src={publicFileUrl(account.qrFileId)}
                alt={account.name}
                width={64}
                height={64}
                style={{ objectFit: "contain", border: "1px solid var(--line)", borderRadius: 4 }}
              />
            ) : null}
            <Upload
              accept="image/png,image/jpeg,image/webp"
              maxCount={1}
              fileList={fileList}
              data-testid="payment-account-qr-input"
              beforeUpload={(file) => {
                setQrFile(file);
                setQrMissing(false);
                return false;
              }}
              onRemove={() => setQrFile(null)}
            >
              <Button icon={<UploadOutlined />}>{t("paymentAccounts.form.chooseQr")}</Button>
            </Upload>
          </Space>
        </Form.Item>
        <Space>
          <Button onClick={onClose}>{t("paymentAccounts.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="payment-account-submit">
            {t("paymentAccounts.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
