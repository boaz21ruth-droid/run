import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { PERM_EVENT_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { toNamePath } from "../events/eventForm";
import { pickText } from "../events/localize";
import { adminEventKey } from "../events/queries";
import { formatInTimezone } from "../time/eventTime";
import { formatDuration, parseDuration } from "./duration";

type AdminEvent = Schemas["AdminEvent"];
type AdminCategory = Schemas["AdminCategory"];
type RefundPolicy = Schemas["RefundPolicy"];
type Proof = Schemas["AdminQualificationProof"];

const proofsKey = (eventId: number) => ["admin", "qualification-proofs", eventId] as const;
const LANGS = ["zh", "en", "km"] as const;

/** 赛事详情的「报名规则」页：退改政策、精英组资格要求与成绩证明核验（v8 设计稿 03、04） */
export function RulesTab({ event }: { event: AdminEvent }) {
  const { data: me } = useMe();
  const canWrite = can(me?.permissions, PERM_EVENT_CONFIG, "write");
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <RefundPolicyCard event={event} canWrite={canWrite} />
      <QualificationCard event={event} canWrite={canWrite} />
      <ProofsCard event={event} canWrite={canWrite} />
    </Space>
  );
}

function useSaveEvent(event: AdminEvent) {
  const queryClient = useQueryClient();
  return (data: AdminEvent) => queryClient.setQueryData(adminEventKey(event.id), data);
}

interface PolicyFormValues {
  enabled: boolean;
  tiers: { days: number | null; percent: number | null }[];
  transfer: boolean;
  transferDays: number | null;
}

function toPolicyForm(policy: RefundPolicy | null): PolicyFormValues {
  return {
    enabled: policy !== null,
    tiers: policy?.tiers.map((t) => ({ days: t.days, percent: t.percent })) ?? [
      { days: 14, percent: 80 },
      { days: 7, percent: 50 },
    ],
    transfer: policy ? policy.transferDays !== null : true,
    transferDays: policy?.transferDays ?? 3,
  };
}

/** 表单值转成接口的退改政策；关闭时为 null。天数按从大到小排序 */
export function toRefundPolicy(values: PolicyFormValues): RefundPolicy | null {
  if (!values.enabled) {
    return null;
  }
  const tiers = values.tiers
    .filter((t) => t.days !== null && t.percent !== null)
    .map((t) => ({ days: t.days ?? 0, percent: t.percent ?? 0 }))
    .sort((a, b) => b.days - a.days);
  return { tiers, transferDays: values.transfer ? (values.transferDays ?? 0) : null };
}

function RefundPolicyCard({ event, canWrite }: { event: AdminEvent; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const { message } = AntdApp.useApp();
  const onSaved = useSaveEvent(event);
  const [form] = Form.useForm<PolicyFormValues>();
  const enabled = Form.useWatch("enabled", form) ?? event.refundPolicy !== null;
  const transfer = Form.useWatch("transfer", form);
  const save = useMutation({
    mutationFn: async (policy: RefundPolicy | null) =>
      unwrap(await api.PUT("/admin/events/{id}/refund-policy", { params: { path: { id: event.id } }, body: { policy } })),
    onSuccess: (data) => {
      onSaved(data);
      form.resetFields();
      void message.success(t("rules.refund.saved"));
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        form.setFields(
          Object.entries(error.fields).map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
            typeof form.setFields
          >[0],
        );
        return;
      }
      void message.error(error.message);
    },
  });

  return (
    <Card title={t("rules.refund.title")}>
      <Typography.Paragraph type="secondary">{t("rules.refund.intro")}</Typography.Paragraph>
      <Form<PolicyFormValues>
        form={form}
        name="refund"
        layout="vertical"
        disabled={!canWrite || save.isPending}
        initialValues={toPolicyForm(event.refundPolicy)}
        onFinish={(values) => save.mutate(toRefundPolicy(values))}
      >
        <Form.Item name="enabled" label={t("rules.refund.enabled")} valuePropName="checked">
          <Switch data-testid="refund-enabled" />
        </Form.Item>
        {enabled ? (
          <>
            <Form.List name="tiers">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: "100%" }}>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" wrap>
                      <span>{t("rules.refund.tierBefore")}</span>
                      <Form.Item name={[field.name, "days"]} rules={[{ required: true, message: t("rules.required") }]} noStyle>
                        <InputNumber min={0} max={365} precision={0} addonAfter={t("rules.refund.days")} data-testid={`refund-days-${field.name}`} />
                      </Form.Item>
                      <span>{t("rules.refund.tierRefund")}</span>
                      <Form.Item name={[field.name, "percent"]} rules={[{ required: true, message: t("rules.required") }]} noStyle>
                        <InputNumber min={0} max={100} precision={0} addonAfter="%" data-testid={`refund-percent-${field.name}`} />
                      </Form.Item>
                      {canWrite ? (
                        <Button type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} aria-label={t("rules.refund.removeTier")} />
                      ) : null}
                    </Space>
                  ))}
                  {canWrite && fields.length < 5 ? (
                    <Button icon={<PlusOutlined />} onClick={() => add({ days: null, percent: null })} data-testid="refund-add-tier">
                      {t("rules.refund.addTier")}
                    </Button>
                  ) : null}
                  <Typography.Text type="secondary">{t("rules.refund.restNone")}</Typography.Text>
                </Space>
              )}
            </Form.List>
            <Space align="baseline" wrap style={{ marginTop: 16 }}>
              <Form.Item name="transfer" valuePropName="checked" noStyle>
                <Switch data-testid="refund-transfer" />
              </Form.Item>
              <span>{t("rules.refund.transfer")}</span>
              {transfer ? (
                <Form.Item name="transferDays" noStyle>
                  <InputNumber min={0} max={365} precision={0} addonBefore={t("rules.refund.transferBefore")} addonAfter={t("rules.refund.days")} data-testid="refund-transfer-days" />
                </Form.Item>
              ) : null}
            </Space>
          </>
        ) : null}
        {canWrite ? (
          <div style={{ marginTop: 16 }}>
            <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="refund-save">
              {t("rules.save")}
            </Button>
          </div>
        ) : null}
      </Form>
    </Card>
  );
}

function QualificationCard({ event, canWrite }: { event: AdminEvent; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const byId = new Map(event.categories.map((c) => [c.id, c]));
  const columns: TableProps<AdminCategory>["columns"] = [
    { title: t("eventDetail.categories.code"), dataIndex: "code", key: "code" },
    { title: t("eventDetail.categories.name"), key: "name", render: (_, c) => pickText(c.name, lang) },
    {
      title: t("rules.qualify.col.requirement"),
      key: "requirement",
      render: (_, c) =>
        c.qualification ? (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Tag color="blue">{t("rules.qualify.elite")}</Tag>
              {c.qualification.maxTimeMs !== null ? <span>≤ {formatDuration(c.qualification.maxTimeMs)}</span> : null}
            </Space>
            <Typography.Text type="secondary">{pickText(c.qualification.rule, lang)}</Typography.Text>
            <Typography.Text type="secondary">
              {t("rules.qualify.fallbackTo", { code: byId.get(c.qualification.fallbackCategoryId)?.code ?? "—" })}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">{t("rules.qualify.none")}</Typography.Text>
        ),
    },
    {
      title: t("rules.qualify.col.actions"),
      key: "actions",
      render: (_, c) =>
        canWrite ? (
          <Button size="small" onClick={() => setEditing(c)} data-testid={`qualify-edit-${c.code}`}>
            {t("rules.qualify.edit")}
          </Button>
        ) : null,
    },
  ];
  return (
    <Card title={t("rules.qualify.title")}>
      <Typography.Paragraph type="secondary">{t("rules.qualify.intro")}</Typography.Paragraph>
      <Table<AdminCategory> rowKey="id" columns={columns} dataSource={event.categories} pagination={false} scroll={{ x: 640 }} />
      {editing ? <QualificationModal event={event} category={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

interface QualifyFormValues {
  required: boolean;
  rule: Record<(typeof LANGS)[number], string>;
  maxTime: string;
  fallbackCategoryId: number | null;
}

function QualificationModal({ event, category, onClose }: { event: AdminEvent; category: AdminCategory; onClose: () => void }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const api = useApi();
  const { message } = AntdApp.useApp();
  const onSaved = useSaveEvent(event);
  const [form] = Form.useForm<QualifyFormValues>();
  const requiredOn = Form.useWatch("required", form) ?? category.qualification !== null;
  const q = category.qualification;
  // 去处：同赛事里其他不要求资格的组别
  const fallbackOptions = event.categories
    .filter((c) => c.id !== category.id && c.qualification === null)
    .map((c) => ({ value: c.id, label: `${c.code} · ${pickText(c.name, lang)}` }));
  const save = useMutation({
    mutationFn: async (qualification: Schemas["AdminQualification"] | null) =>
      unwrap(await api.PUT("/admin/categories/{id}/qualification", { params: { path: { id: category.id } }, body: { qualification } })),
    onSuccess: (data) => {
      onSaved(data);
      void message.success(t("rules.qualify.saved"));
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        form.setFields(
          Object.entries(error.fields).map(([field, text]) => ({
            name: field === "maxTimeMs" ? ["maxTime"] : toNamePath(field),
            errors: [text],
          })) as Parameters<typeof form.setFields>[0],
        );
        return;
      }
      void message.error(error.message);
    },
  });
  const onFinish = (values: QualifyFormValues) => {
    if (!values.required) {
      save.mutate(null);
      return;
    }
    save.mutate({
      rule: { zh: values.rule.zh.trim(), en: values.rule.en.trim(), km: values.rule.km.trim() },
      maxTimeMs: values.maxTime.trim() ? parseDuration(values.maxTime) : null,
      fallbackCategoryId: values.fallbackCategoryId ?? 0,
    });
  };
  const requiredRule = [{ required: true, whitespace: true, message: t("rules.required") }];

  return (
    <Modal open title={t("rules.qualify.editTitle", { code: category.code })} onCancel={onClose} footer={null} width={640} maskClosable={false}>
      <Form<QualifyFormValues>
        form={form}
        name="qualify"
        layout="vertical"
        disabled={save.isPending}
        onFinish={onFinish}
        initialValues={{
          required: q !== null,
          rule: { zh: q?.rule.zh ?? "", en: q?.rule.en ?? "", km: q?.rule.km ?? "" },
          maxTime: q?.maxTimeMs ? formatDuration(q.maxTimeMs) : "",
          fallbackCategoryId: q?.fallbackCategoryId ?? fallbackOptions[0]?.value ?? null,
        }}
      >
        <Form.Item name="required" label={t("rules.qualify.required")} valuePropName="checked">
          <Switch data-testid="qualify-required" />
        </Form.Item>
        {requiredOn ? (
          <>
            {LANGS.map((l) => (
              <Form.Item key={l} name={["rule", l]} label={t(`rules.qualify.rule.${l}`)} rules={requiredRule}>
                <Input maxLength={200} placeholder={t("rules.qualify.rulePlaceholder")} />
              </Form.Item>
            ))}
            <Row gutter={16}>
              <Col xs={24} md={10}>
                <Form.Item
                  name="maxTime"
                  label={t("rules.qualify.maxTime")}
                  extra={t("rules.qualify.maxTimeHelp")}
                  rules={[
                    {
                      validator: (_: unknown, value: string | undefined) =>
                        !value?.trim() || parseDuration(value) !== null
                          ? Promise.resolve()
                          : Promise.reject(new Error(t("rules.qualify.timeInvalid"))),
                    },
                  ]}
                >
                  <Input placeholder="1:45:00" maxLength={8} />
                </Form.Item>
              </Col>
              <Col xs={24} md={14}>
                <Form.Item name="fallbackCategoryId" label={t("rules.qualify.fallback")} extra={t("rules.qualify.fallbackHelp")} rules={[{ required: true, message: t("rules.required") }]}>
                  <Select options={fallbackOptions} data-testid="qualify-fallback" />
                </Form.Item>
              </Col>
            </Row>
          </>
        ) : null}
        <Space style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button onClick={onClose}>{t("rules.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="qualify-save">
            {t("rules.save")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}

function ProofsCard({ event, canWrite }: { event: AdminEvent; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const [rejecting, setRejecting] = useState<Proof | null>(null);
  const [note, setNote] = useState("");
  const list = useQuery({
    queryKey: proofsKey(event.id),
    queryFn: async () => unwrap(await api.GET("/admin/events/{id}/qualification-proofs", { params: { path: { id: event.id } } })),
  });
  const review = useMutation({
    mutationFn: async (vars: { id: number; approve: boolean; note?: string }) =>
      vars.approve
        ? unwrap(await api.POST("/admin/qualification-proofs/{id}/approve", { params: { path: { id: vars.id } } }))
        : unwrap(
            await api.POST("/admin/qualification-proofs/{id}/reject", {
              params: { path: { id: vars.id } },
              body: vars.note ? { note: vars.note } : {},
            }),
          ),
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: proofsKey(event.id) });
      // 转组改了组别名额
      void queryClient.invalidateQueries({ queryKey: adminEventKey(event.id) });
      void message.success(t(vars.approve ? "rules.proofs.approved" : "rules.proofs.rejected"));
      setRejecting(null);
      setNote("");
    },
    onError: (error) => void message.error(error.message),
  });
  const items = list.data?.items ?? [];
  const pending = items.filter((p) => p.status === "PENDING").length;

  const columns: TableProps<Proof>["columns"] = [
    {
      title: t("rules.proofs.col.runner"),
      key: "runner",
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{p.fullName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {p.regNo} · {p.categoryCode}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("rules.proofs.col.time"),
      key: "time",
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{formatDuration(p.bestTimeMs)}</Typography.Text>
          {p.maxTimeMs !== null ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ≤ {formatDuration(p.maxTimeMs)}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("rules.proofs.col.proof"),
      key: "proof",
      render: (_, p) => (
        <Space direction="vertical" size={0}>
          <span>{p.source}</span>
          <Typography.Link href={p.proofUrl} target="_blank" rel="noreferrer noopener" ellipsis style={{ maxWidth: 240 }}>
            {p.proofUrl.replace(/^https?:\/\//, "")}
          </Typography.Link>
        </Space>
      ),
    },
    {
      title: t("rules.proofs.col.submitted"),
      key: "createdAt",
      render: (_, p) => formatInTimezone(p.createdAt, event.timezone),
    },
    {
      title: t("rules.proofs.col.status"),
      key: "status",
      render: (_, p) => (
        <Space direction="vertical" size={2}>
          <Tag color={p.status === "APPROVED" ? "green" : p.status === "PENDING" ? "orange" : "default"}>{t(`rules.proofs.status.${p.status}`)}</Tag>
          {p.movedToCategoryCode ? <Typography.Text type="secondary">{t("rules.proofs.movedTo", { code: p.movedToCategoryCode })}</Typography.Text> : null}
          {p.reviewNote ? <Typography.Text type="secondary">{p.reviewNote}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: t("rules.proofs.col.actions"),
      key: "actions",
      render: (_, p) => {
        if (!canWrite || p.status !== "PENDING") {
          return null;
        }
        const waiting = p.registrationStatus !== "CONFIRMED";
        const buttons = (
          <Space>
            <Button
              size="small"
              type="primary"
              disabled={waiting}
              loading={review.isPending && review.variables?.id === p.id && review.variables.approve}
              onClick={() => review.mutate({ id: p.id, approve: true })}
              data-testid={`proof-approve-${p.id}`}
            >
              {t("rules.proofs.approve")}
            </Button>
            <Button size="small" disabled={waiting} onClick={() => setRejecting(p)} data-testid={`proof-reject-${p.id}`}>
              {t("rules.proofs.reject")}
            </Button>
          </Space>
        );
        return waiting ? <Tooltip title={t("rules.proofs.waitPayment")}>{buttons}</Tooltip> : buttons;
      },
    },
  ];

  return (
    <Card
      title={t("rules.proofs.title")}
      extra={
        list.data ? (
          <Typography.Text type="secondary" data-testid="proofs-summary">
            {t("rules.proofs.summary", { pending, total: items.length })}
          </Typography.Text>
        ) : null
      }
    >
      {list.isError ? <Alert type="error" showIcon message={list.error.message} /> : null}
      <Table<Proof>
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={list.isPending}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 900 }}
        locale={{ emptyText: t("rules.proofs.empty") }}
      />
      {rejecting ? (
        <Modal
          open
          title={t("rules.proofs.rejectTitle", { name: rejecting.fullName })}
          onCancel={() => setRejecting(null)}
          onOk={() => review.mutate({ id: rejecting.id, approve: false, note: note.trim() })}
          okText={t("rules.proofs.rejectConfirm")}
          okButtonProps={{ danger: true, loading: review.isPending, "data-testid": "proof-reject-confirm" }}
          cancelText={t("rules.cancel")}
        >
          <Typography.Paragraph>
            {t("rules.proofs.rejectBody", { code: rejecting.fallbackCategoryCode ?? "—" })}
          </Typography.Paragraph>
          <Input.TextArea
            rows={3}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("rules.proofs.notePlaceholder")}
            data-testid="proof-reject-note"
          />
        </Modal>
      ) : null}
    </Card>
  );
}
