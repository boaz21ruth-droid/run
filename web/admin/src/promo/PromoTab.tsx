import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
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
  Typography,
  type TableProps,
} from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { PERM_COUPON_MANAGE, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { formatDiscount, parseDiscountValue } from "../coupons/couponForm";
import { toNamePath } from "../events/eventForm";
import { formatInTimezone } from "../time/eventTime";

type AdminEvent = Schemas["AdminEvent"];
type ReferralLink = Schemas["ReferralLink"];
type CompRequest = Schemas["AdminCompRequest"];
type DiscountType = Schemas["DiscountType"];

const REFERRAL_KINDS: Schemas["ReferralKind"][] = ["CLUB", "KOL", "SPONSOR", "CHANNEL", "OTHER"];

const linksKey = (eventId: number) => ["admin", "referral-links", eventId] as const;
const compKey = (eventId: number) => ["admin", "comp-requests", eventId] as const;

/** 用户站地址：后台在 admin.<域名>，用户站在 <域名>；本地开发两者同源时退回当前地址 */
export function userSiteOrigin(location: Pick<Location, "protocol" | "host"> = window.location): string {
  const host = location.host.replace(/^admin\./, "");
  return `${location.protocol}//${host}`;
}

/** 从名称猜一个链接地址：小写字母、数字、连字符 */
export function suggestSlug(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function conversion(paid: number, clicks: number): string {
  return clicks > 0 ? `${((paid / clicks) * 100).toFixed(1)}%` : "—";
}

/** 赛事详情的「推广」页：推荐链接与渠道归因、免费入场名额与审批（v8 设计稿 10） */
export function PromoTab({ event }: { event: AdminEvent }) {
  const { data: me } = useMe();
  const canWrite = can(me?.permissions, PERM_COUPON_MANAGE, "write");
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <ReferralCard event={event} canWrite={canWrite} />
      <CompCard event={event} canWrite={canWrite} />
    </Space>
  );
}

function ReferralCard({ event, canWrite }: { event: AdminEvent; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const [creating, setCreating] = useState(false);
  const links = useQuery({
    queryKey: linksKey(event.id),
    queryFn: async () => unwrap(await api.GET("/admin/events/{id}/referral-links", { params: { path: { id: event.id } } })),
  });
  const toggle = useMutation({
    mutationFn: async (link: ReferralLink) =>
      unwrap(
        await api.PUT("/admin/referral-links/{id}", {
          params: { path: { id: link.id } },
          body: { label: link.label, status: link.status === "ACTIVE" ? "DISABLED" : "ACTIVE" },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: linksKey(event.id) });
      void message.success(t("promo.links.saved"));
    },
    onError: (error) => void message.error(error.message),
  });
  const origin = userSiteOrigin();

  const columns: TableProps<ReferralLink>["columns"] = [
    {
      title: t("promo.links.col.source"),
      key: "source",
      render: (_, link) => (
        <Space size={6} wrap>
          <Typography.Text strong>{link.label}</Typography.Text>
          <Tag>{t(`promo.kind.${link.kind}`)}</Tag>
        </Space>
      ),
    },
    {
      title: t("promo.links.col.link"),
      key: "link",
      render: (_, link) => (
        <Space direction="vertical" size={0}>
          <Typography.Text copyable={{ text: `${origin}/r/${link.slug}` }} data-testid={`referral-url-${link.slug}`}>
            /r/{link.slug}
          </Typography.Text>
          <Typography.Text type="secondary" copyable={{ text: `ref-${link.slug}` }} style={{ fontSize: 12 }}>
            {t("promo.links.startapp", { param: `ref-${link.slug}` })}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("promo.links.col.coupon"),
      key: "coupon",
      render: (_, link) =>
        link.coupon ? (
          <Space direction="vertical" size={0}>
            <Typography.Text code>{link.coupon.code}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDiscount(link.coupon, t("coupons.discountType.WAIVER"), (price) => t("coupons.priceEach", { price }))} ·{" "}
              {link.coupon.usedCount + link.coupon.reservedCount} / {link.coupon.quota}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    { title: t("promo.links.col.clicks"), dataIndex: "clickCount", key: "clicks", align: "right" },
    { title: t("promo.links.col.orders"), dataIndex: "orders", key: "orders", align: "right" },
    { title: t("promo.links.col.paid"), dataIndex: "paidOrders", key: "paid", align: "right" },
    {
      title: t("promo.links.col.conversion"),
      key: "conversion",
      align: "right",
      render: (_, link) => conversion(link.paidOrders, link.clickCount),
    },
    {
      title: t("promo.links.col.status"),
      key: "status",
      render: (_, link) =>
        canWrite ? (
          <Switch
            size="small"
            checked={link.status === "ACTIVE"}
            loading={toggle.isPending && toggle.variables?.id === link.id}
            onChange={() => toggle.mutate(link)}
            aria-label={t("promo.links.toggle", { label: link.label })}
          />
        ) : (
          <Tag color={link.status === "ACTIVE" ? "green" : "default"}>{t(`coupons.status.${link.status}`)}</Tag>
        ),
    },
  ];

  return (
    <Card
      title={t("promo.links.title")}
      extra={
        canWrite ? (
          <Button type="primary" onClick={() => setCreating(true)} data-testid="referral-create">
            {t("promo.links.create")}
          </Button>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary">{t("promo.links.intro")}</Typography.Paragraph>
      {links.isError ? <Alert type="error" showIcon message={links.error.message} /> : null}
      <Table<ReferralLink>
        rowKey="id"
        columns={columns}
        dataSource={links.data?.items ?? []}
        loading={links.isPending}
        pagination={false}
        scroll={{ x: 960 }}
        locale={{ emptyText: t("promo.links.empty") }}
        summary={() =>
          links.data ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={4}>
                <Typography.Text type="secondary">{t("promo.links.direct")}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                <span data-testid="direct-orders">{links.data.directOrders}</span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">
                {links.data.directPaidOrders}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6} colSpan={2} />
            </Table.Summary.Row>
          ) : null
        }
      />
      {creating ? <CreateLinkModal event={event} onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

interface LinkFormValues {
  label: string;
  slug: string;
  kind: Schemas["ReferralKind"];
  withOffer: boolean;
  code?: string;
  discountType?: DiscountType;
  discountValue?: string;
  quota?: number | null;
}

function CreateLinkModal({ event, onClose }: { event: AdminEvent; onClose: () => void }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<LinkFormValues>();
  const withOffer = Form.useWatch("withOffer", form) ?? true;
  const discountType = Form.useWatch("discountType", form) ?? "PRICE";
  const required = [{ required: true, message: t("form.required") }];
  const create = useMutation({
    mutationFn: async (body: Schemas["CreateReferralLinkRequest"]) =>
      unwrap(await api.POST("/admin/events/{id}/referral-links", { params: { path: { id: event.id } }, body })),
  });
  const hasFieldErrors = create.error instanceof ApiError && Object.keys(create.error.fields).length > 0;

  const onValuesChange = (changed: Partial<LinkFormValues>, all: LinkFormValues) => {
    // 名称改动时顺手填链接地址与推荐码，已经手改过的不覆盖
    if (changed.label !== undefined && !form.isFieldTouched("slug")) {
      const slug = suggestSlug(changed.label);
      form.setFieldValue("slug", slug);
      if (!form.isFieldTouched("code")) {
        form.setFieldValue("code", slug.toUpperCase());
      }
    }
    if (changed.slug !== undefined && !form.isFieldTouched("code") && all.withOffer) {
      form.setFieldValue("code", changed.slug.toUpperCase());
    }
  };

  const onFinish = (values: LinkFormValues) => {
    const body: Schemas["CreateReferralLinkRequest"] = {
      slug: values.slug.trim().toLowerCase(),
      label: values.label.trim(),
      kind: values.kind,
    };
    if (values.withOffer) {
      const type = values.discountType ?? "PRICE";
      body.offer = {
        code: (values.code ?? "").trim().toUpperCase(),
        discountType: type,
        discountValue: parseDiscountValue(type, values.discountValue) ?? 0,
        quota: values.quota ?? 0,
      };
    }
    create.mutate(body, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: linksKey(event.id) });
        void message.success(t("promo.links.created"));
        onClose();
      },
      onError: (error) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          form.setFields(
            Object.entries(error.fields).map(([field, text]) => ({
              name: toNamePath(field.replace(/^offer\./, "")),
              errors: [text],
            })) as Parameters<typeof form.setFields>[0],
          );
        }
      },
    });
  };

  return (
    <Modal open title={t("promo.links.createTitle")} onCancel={onClose} footer={null} width={640} maskClosable={false}>
      {create.error && !hasFieldErrors ? <Alert type="error" showIcon message={create.error.message} style={{ marginBottom: 16 }} /> : null}
      <Form<LinkFormValues>
        form={form}
        name="referral"
        layout="vertical"
        onFinish={onFinish}
        onValuesChange={onValuesChange}
        disabled={create.isPending}
        initialValues={{ label: "", slug: "", kind: "CLUB", withOffer: true, code: "", discountType: "PRICE", discountValue: "", quota: 500 }}
      >
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item name="label" label={t("promo.links.form.label")} rules={required}>
              <Input maxLength={60} placeholder={t("promo.links.form.labelPlaceholder")} />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item name="kind" label={t("promo.links.form.kind")} rules={required}>
              <Select options={REFERRAL_KINDS.map((k) => ({ value: k, label: t(`promo.kind.${k}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="slug"
          label={t("promo.links.form.slug")}
          extra={t("promo.links.form.slugHelp")}
          rules={[...required, { pattern: /^[a-z0-9-]{2,32}$/, message: t("promo.links.form.slugInvalid") }]}
        >
          <Input addonBefore="/r/" maxLength={32} />
        </Form.Item>
        <Form.Item name="withOffer" label={t("promo.links.form.withOffer")} valuePropName="checked">
          <Switch />
        </Form.Item>
        {withOffer ? (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="code" label={t("coupons.form.code")} extra={t("coupons.form.codeHelp")} rules={required}>
                <Input maxLength={32} style={{ textTransform: "uppercase" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="quota" label={t("coupons.form.quota")} rules={required}>
                <InputNumber min={1} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="discountType" label={t("coupons.form.discountType")} rules={required}>
                <Select
                  options={(["PRICE", "AMOUNT", "PERCENT", "WAIVER"] as const).map((v) => ({
                    value: v,
                    label: t(`coupons.discountType.${v}`),
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="discountValue"
                label={t("coupons.form.discountValue")}
                dependencies={["discountType"]}
                extra={discountType === "PRICE" ? t("promo.links.form.priceHelp") : undefined}
                rules={[
                  {
                    validator: (_: unknown, value: string | undefined) =>
                      parseDiscountValue(discountType, value) !== null
                        ? Promise.resolve()
                        : Promise.reject(
                            new Error(
                              t(
                                discountType === "PERCENT"
                                  ? "coupons.form.percentInvalid"
                                  : discountType === "PRICE"
                                    ? "coupons.form.priceInvalid"
                                    : "coupons.form.amountInvalid",
                              ),
                            ),
                          ),
                  },
                ]}
              >
                <Input
                  inputMode="decimal"
                  disabled={discountType === "WAIVER"}
                  addonBefore={discountType === "AMOUNT" || discountType === "PRICE" ? "$" : undefined}
                  addonAfter={discountType === "PERCENT" ? "%" : undefined}
                />
              </Form.Item>
            </Col>
          </Row>
        ) : null}
        <Space style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button onClick={onClose}>{t("coupons.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={create.isPending} data-testid="referral-submit">
            {t("coupons.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}

function CompCard({ event, canWrite }: { event: AdminEvent; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const [rejecting, setRejecting] = useState<CompRequest | null>(null);
  const [draftQuota, setDraftQuota] = useState<number | null | undefined>(undefined);
  const list = useQuery({
    queryKey: compKey(event.id),
    queryFn: async () => unwrap(await api.GET("/admin/events/{id}/comp-requests", { params: { path: { id: event.id } } })),
  });
  const onSaved = (data: Schemas["CompRequestList"]) => queryClient.setQueryData(compKey(event.id), data);
  const saveQuota = useMutation({
    mutationFn: async (quota: number | null) =>
      unwrap(await api.PUT("/admin/events/{id}/comp-quota", { params: { path: { id: event.id } }, body: { quota } })),
    onSuccess: (data) => {
      onSaved(data);
      setDraftQuota(undefined);
      void message.success(t("promo.comp.quotaSaved"));
    },
    onError: (error) => void message.error(error instanceof ApiError ? (Object.values(error.fields)[0] ?? error.message) : error.message),
  });
  const review = useMutation({
    mutationFn: async (vars: { id: number; approve: boolean; note?: string }) =>
      vars.approve
        ? unwrap(await api.POST("/admin/comp-requests/{id}/approve", { params: { path: { id: vars.id } } }))
        : unwrap(
            await api.POST("/admin/comp-requests/{id}/reject", {
              params: { path: { id: vars.id } },
              body: vars.note ? { note: vars.note } : {},
            }),
          ),
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: compKey(event.id) });
      void message.success(t(vars.approve ? "promo.comp.approved" : "promo.comp.rejected"));
      setRejecting(null);
    },
    onError: (error) => void message.error(error.message),
  });

  const data = list.data;
  const quota = draftQuota !== undefined ? draftQuota : (data?.quota ?? null);
  const open = quota !== null;

  const columns: TableProps<CompRequest>["columns"] = [
    {
      title: t("promo.comp.col.applicant"),
      key: "applicant",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6} wrap>
            <Typography.Text strong>{r.applicantName}</Typography.Text>
            <Tag>{t(`promo.compKind.${r.kind}`)}</Tag>
          </Space>
          {r.telegramUsername ? (
            <Typography.Link href={`https://t.me/${r.telegramUsername}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              @{r.telegramUsername}
            </Typography.Link>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("promo.comp.col.profile"),
      key: "profile",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          {r.profileUrl ? (
            <Typography.Link href={r.profileUrl} target="_blank" rel="noreferrer noopener" ellipsis style={{ maxWidth: 240 }}>
              {r.profileUrl.replace(/^https?:\/\//, "")}
            </Typography.Link>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          )}
          {r.audience ? <Typography.Text type="secondary">{r.audience}</Typography.Text> : null}
          {r.note ? (
            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, expandable: true }} style={{ margin: 0, maxWidth: 280 }}>
              {r.note}
            </Typography.Paragraph>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("promo.comp.col.submitted"),
      key: "createdAt",
      render: (_, r) => formatInTimezone(r.createdAt, event.timezone),
    },
    {
      title: t("promo.comp.col.status"),
      key: "status",
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={r.status === "APPROVED" ? "green" : r.status === "PENDING" ? "orange" : "default"}>
            {t(`promo.comp.status.${r.status}`)}
          </Tag>
          {r.couponCode ? (
            <Space size={4}>
              <Typography.Text code copyable>
                {r.couponCode}
              </Typography.Text>
              {r.couponUsed ? <Tag color="blue">{t("promo.comp.used")}</Tag> : null}
            </Space>
          ) : null}
          {r.reviewNote ? <Typography.Text type="secondary">{r.reviewNote}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: t("promo.comp.col.actions"),
      key: "actions",
      render: (_, r) =>
        canWrite && r.status === "PENDING" ? (
          <Space>
            <Button
              size="small"
              type="primary"
              loading={review.isPending && review.variables?.id === r.id && review.variables.approve}
              onClick={() => review.mutate({ id: r.id, approve: true })}
              data-testid={`comp-approve-${r.id}`}
            >
              {t("promo.comp.approve")}
            </Button>
            <Button size="small" onClick={() => setRejecting(r)} data-testid={`comp-reject-${r.id}`}>
              {t("promo.comp.reject")}
            </Button>
          </Space>
        ) : null,
    },
  ];

  return (
    <Card
      title={t("promo.comp.title")}
      extra={
        data ? (
          <Typography.Text type="secondary" data-testid="comp-summary">
            {t("promo.comp.summary", {
              approved: data.approved,
              quota: data.quota ?? "—",
              pending: data.pending,
            })}
          </Typography.Text>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary">{t("promo.comp.intro")}</Typography.Paragraph>
      {list.isError ? <Alert type="error" showIcon message={list.error.message} /> : null}
      <Space wrap align="center" style={{ marginBottom: 16 }}>
        <Switch
          checked={open}
          disabled={!canWrite || !data}
          onChange={(on) => setDraftQuota(on ? Math.max(data?.approved ?? 0, data?.quota ?? 0, 10) : null)}
          aria-label={t("promo.comp.open")}
          data-testid="comp-open"
        />
        <span>{t("promo.comp.open")}</span>
        {open ? (
          <>
            <span>{t("promo.comp.quota")}</span>
            <InputNumber
              min={data?.approved ?? 0}
              precision={0}
              value={quota}
              disabled={!canWrite}
              onChange={(v) => setDraftQuota(v ?? 0)}
              data-testid="comp-quota"
              aria-label={t("promo.comp.quota")}
            />
          </>
        ) : null}
        {canWrite && draftQuota !== undefined ? (
          <Button type="primary" loading={saveQuota.isPending} onClick={() => saveQuota.mutate(draftQuota)} data-testid="comp-quota-save">
            {t("promo.comp.saveQuota")}
          </Button>
        ) : null}
      </Space>
      <Table<CompRequest>
        rowKey="id"
        columns={columns}
        dataSource={data?.items ?? []}
        loading={list.isPending}
        pagination={false}
        scroll={{ x: 880 }}
        locale={{ emptyText: t("promo.comp.empty") }}
      />
      {rejecting ? (
        <RejectModal
          request={rejecting}
          loading={review.isPending}
          onCancel={() => setRejecting(null)}
          onConfirm={(note) => review.mutate({ id: rejecting.id, approve: false, note })}
        />
      ) : null}
    </Card>
  );
}

function RejectModal({
  request,
  loading,
  onCancel,
  onConfirm,
}: {
  request: CompRequest;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const { t } = useTranslation("admin");
  const [note, setNote] = useState("");
  return (
    <Modal
      open
      title={t("promo.comp.rejectTitle", { name: request.applicantName })}
      onCancel={onCancel}
      onOk={() => onConfirm(note.trim())}
      okText={t("promo.comp.reject")}
      okButtonProps={{ danger: true, loading, "data-testid": "comp-reject-confirm" }}
      cancelText={t("coupons.cancel")}
    >
      <Typography.Paragraph type="secondary">{t("promo.comp.rejectHelp")}</Typography.Paragraph>
      <Input.TextArea rows={3} maxLength={200} showCount value={note} onChange={(e) => setNote(e.target.value)} data-testid="comp-reject-note" />
    </Modal>
  );
}
