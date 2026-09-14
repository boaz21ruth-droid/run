import { PlusOutlined } from "@ant-design/icons";
import { ApiError, formatUsd, parseUsdToCents, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import {
  Alert,
  App as AntdApp,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import dayjs from "dayjs";
import { useState, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { PERM_PRICE_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import {
  emptyPriceRule,
  fromPriceRule,
  isPriceRuleLocked,
  priceRuleFieldPath,
  toPriceRuleInput,
  type PriceRuleFormValues,
} from "./priceRuleForm";
import { usePriceRules, useSavePriceRule } from "./queries";

type AdminEvent = Schemas["AdminEvent"];
type PriceRule = Schemas["PriceRule"];

const NAME_LANGS = ["zh", "en", "km"] as const;
const NAME_LABEL_KEYS = { zh: "form.nameZh", en: "form.nameEn", km: "form.nameKm" } as const;

function formatTime(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

export function PricingTab({ event }: { event: AdminEvent }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { data: me } = useMe();
  const rules = usePriceRules(event.id);
  const canWrite = can(me?.permissions, PERM_PRICE_CONFIG, "write");
  const [editing, setEditing] = useState<{ rule?: PriceRule } | null>(null);
  const codeById = new Map(event.categories.map((category) => [category.id, category.code]));

  const columns: TableProps<PriceRule>["columns"] = [
    { title: t("pricing.col.name"), key: "name", render: (_, rule) => pickText(rule.name, lang) },
    {
      title: t("pricing.col.audience"),
      key: "audience",
      render: (_, rule) => <Tag color={rule.audience === "LOCAL" ? "gold" : "blue"}>{t(`pricing.audience.${rule.audience}`)}</Tag>,
    },
    { title: t("pricing.col.price"), key: "price", render: (_, rule) => formatUsd(rule.priceCents) },
    {
      title: t("pricing.col.quota"),
      key: "quota",
      render: (_, rule) => `${rule.usedCount + rule.reservedCount} / ${rule.quota ?? t("pricing.unlimited")}`,
    },
    {
      title: t("pricing.col.sale"),
      key: "sale",
      render: (_, rule) => `${formatTime(rule.saleStartsAt)} ~ ${formatTime(rule.saleEndsAt)}`,
    },
    {
      title: t("pricing.col.categories"),
      key: "categories",
      render: (_, rule) => (
        <Space size={4} wrap>
          {rule.categoryIds.map((id) => (
            <Tag key={id}>{codeById.get(id) ?? id}</Tag>
          ))}
        </Space>
      ),
    },
    { title: t("pricing.col.sortOrder"), dataIndex: "sortOrder", key: "sortOrder" },
    {
      title: t("pricing.col.actions"),
      key: "actions",
      render: (_, rule) =>
        canWrite ? (
          <Button size="small" data-testid={`price-rule-edit-${rule.id}`} onClick={() => setEditing({ rule })}>
            {t("pricing.edit")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Text type="secondary">{t("pricing.hint")}</Typography.Text>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} data-testid="price-rule-create" onClick={() => setEditing({})}>
            {t("pricing.create")}
          </Button>
        ) : null}
      </Space>
      {rules.isError ? <Alert type="error" showIcon message={rules.error.message} /> : null}
      <Table<PriceRule>
        rowKey="id"
        columns={columns}
        dataSource={rules.data ?? []}
        loading={rules.isPending}
        pagination={false}
        locale={{ emptyText: t("pricing.empty") }}
        scroll={{ x: 960 }}
        onRow={(rule) => ({ "data-testid": `price-rule-row-${rule.id}` }) as HTMLAttributes<HTMLElement>}
      />
      {editing ? <PriceRuleModal event={event} rule={editing.rule} onClose={() => setEditing(null)} /> : null}
    </Space>
  );
}

interface PriceRuleModalProps {
  event: AdminEvent;
  rule?: PriceRule;
  onClose: () => void;
}

function PriceRuleModal({ event, rule, onClose }: PriceRuleModalProps) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PriceRuleFormValues>();
  const save = useSavePriceRule(event.id);
  const locked = isPriceRuleLocked(rule);
  const required = [{ required: true, message: t("form.required") }];
  const bannerError = save.error instanceof ApiError && save.error.code === "VALIDATION_FAILED" ? null : save.error;

  const onFinish = (values: PriceRuleFormValues) => {
    save.mutate(
      { id: rule?.id, body: toPriceRuleInput(values) },
      {
        onSuccess: () => {
          void message.success(t(rule ? "pricing.updated" : "pricing.created"));
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "VALIDATION_FAILED") {
            form.setFields(
              Object.entries(error.fields).map(([field, text]) => ({
                name: priceRuleFieldPath(field),
                errors: [text],
              })) as Parameters<typeof form.setFields>[0],
            );
          }
        },
      },
    );
  };

  return (
    <Modal open title={t(rule ? "pricing.editTitle" : "pricing.createTitle")} onCancel={onClose} footer={null} width={760} maskClosable={false}>
      {bannerError ? <Alert type="error" showIcon message={bannerError.message} style={{ marginBottom: 16 }} /> : null}
      {locked ? <Alert type="info" showIcon message={t("pricing.lockedHint")} style={{ marginBottom: 16 }} /> : null}
      <Form<PriceRuleFormValues>
        form={form}
        name="priceRule"
        layout="vertical"
        onFinish={onFinish}
        disabled={save.isPending}
        initialValues={rule ? fromPriceRule(rule) : emptyPriceRule(event.categories.map((category) => category.id))}
      >
        <Typography.Text strong>{t("pricing.form.name")}</Typography.Text>
        <Row gutter={16}>
          {NAME_LANGS.map((l) => (
            <Col key={l} xs={24} md={8}>
              <Form.Item name={["name", l]} label={t(NAME_LABEL_KEYS[l])} rules={required}>
                <Input lang={l} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="audience" label={t("pricing.form.audience")} rules={required}>
              <Select
                disabled={locked}
                options={[
                  { value: "ALL", label: t("pricing.audience.ALL") },
                  { value: "LOCAL", label: t("pricing.audience.LOCAL") },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              name="priceUsd"
              label={t("pricing.form.priceUsd")}
              rules={[
                ...required,
                {
                  validator: (_: unknown, value: string | undefined) =>
                    !value || parseUsdToCents(value) !== null
                      ? Promise.resolve()
                      : Promise.reject(new Error(t("pricing.form.priceInvalid"))),
                },
              ]}
            >
              <Input addonBefore="$" inputMode="decimal" disabled={locked} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="quota" label={t("pricing.form.quota")} extra={t("pricing.form.quotaHelp")}>
              <InputNumber min={0} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="sortOrder" label={t("pricing.form.sortOrder")}>
              <InputNumber min={0} max={32767} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="saleStartsAt" label={t("pricing.form.saleStartsAt")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="saleEndsAt" label={t("pricing.form.saleEndsAt")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="categoryIds" label={t("pricing.form.categoryIds")} rules={required}>
          <Select
            mode="multiple"
            disabled={locked}
            options={event.categories.map((category) => ({
              value: category.id,
              label: `${category.code} · ${pickText(category.name, lang)}`,
            }))}
          />
        </Form.Item>
        <Space>
          <Button onClick={onClose}>{t("pricing.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="price-rule-submit">
            {t("pricing.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
