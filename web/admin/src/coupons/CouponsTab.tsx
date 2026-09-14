import { PlusOutlined } from "@ant-design/icons";
import { ApiError, type Schemas } from "@werun/api-client";
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
import { PERM_COUPON_MANAGE, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { toNamePath } from "../events/eventForm";
import {
  emptyCoupon,
  formatDiscount,
  fromCoupon,
  parseDiscountValue,
  toCreateCouponRequest,
  toUpdateCouponRequest,
  type CouponFormValues,
} from "./couponForm";
import { useCoupons, useSaveCoupon } from "./queries";

type AdminEvent = Schemas["AdminEvent"];
type Coupon = Schemas["Coupon"];

function formatTime(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

export function CouponsTab({ event }: { event: AdminEvent }) {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const coupons = useCoupons(event.id);
  const canWrite = can(me?.permissions, PERM_COUPON_MANAGE, "write");
  const [editing, setEditing] = useState<{ coupon?: Coupon } | null>(null);

  const columns: TableProps<Coupon>["columns"] = [
    { title: t("coupons.col.code"), dataIndex: "code", key: "code" },
    {
      title: t("coupons.col.discount"),
      key: "discount",
      render: (_, coupon) => formatDiscount(coupon, t("coupons.discountType.WAIVER")),
    },
    {
      title: t("coupons.col.quota"),
      key: "quota",
      render: (_, coupon) => `${coupon.usedCount + coupon.reservedCount} / ${coupon.quota}`,
    },
    { title: t("coupons.col.minRunners"), key: "minRunners", render: (_, coupon) => coupon.minRunners ?? "—" },
    {
      title: t("coupons.col.validity"),
      key: "validity",
      render: (_, coupon) => `${formatTime(coupon.validFrom)} ~ ${formatTime(coupon.validUntil)}`,
    },
    {
      title: t("coupons.col.status"),
      key: "status",
      render: (_, coupon) => (
        <Tag color={coupon.status === "ACTIVE" ? "green" : "default"}>{t(`coupons.status.${coupon.status}`)}</Tag>
      ),
    },
    {
      title: t("coupons.col.actions"),
      key: "actions",
      render: (_, coupon) =>
        canWrite ? (
          <Button size="small" data-testid={`coupon-edit-${coupon.code}`} onClick={() => setEditing({ coupon })}>
            {t("coupons.edit")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Text type="secondary">{t("coupons.hint")}</Typography.Text>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} data-testid="coupon-create" onClick={() => setEditing({})}>
            {t("coupons.create")}
          </Button>
        ) : null}
      </Space>
      {coupons.isError ? <Alert type="error" showIcon message={coupons.error.message} /> : null}
      <Table<Coupon>
        rowKey="id"
        columns={columns}
        dataSource={coupons.data ?? []}
        loading={coupons.isPending}
        pagination={false}
        locale={{ emptyText: t("coupons.empty") }}
        scroll={{ x: 900 }}
        onRow={(coupon) => ({ "data-testid": `coupon-row-${coupon.code}` }) as HTMLAttributes<HTMLElement>}
      />
      {editing ? <CouponModal event={event} coupon={editing.coupon} onClose={() => setEditing(null)} /> : null}
    </Space>
  );
}

interface CouponModalProps {
  event: AdminEvent;
  coupon?: Coupon;
  onClose: () => void;
}

function CouponModal({ event, coupon, onClose }: CouponModalProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CouponFormValues>();
  const discountType = Form.useWatch("discountType", form) ?? coupon?.discountType ?? "PERCENT";
  const save = useSaveCoupon(event.id);
  const required = [{ required: true, message: t("form.required") }];
  const hasFieldErrors = save.error instanceof ApiError && Object.keys(save.error.fields).length > 0;
  const bannerError = save.error && !hasFieldErrors ? save.error : null;

  const onFinish = (values: CouponFormValues) => {
    const input = coupon
      ? { id: coupon.id, body: toUpdateCouponRequest(values, coupon.eventId) }
      : { id: undefined, body: toCreateCouponRequest(values, event.id) };
    save.mutate(input, {
      onSuccess: () => {
        void message.success(t(coupon ? "coupons.updated" : "coupons.created"));
        onClose();
      },
      onError: (error) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          form.setFields(
            Object.entries(error.fields).map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
              typeof form.setFields
            >[0],
          );
        }
      },
    });
  };

  return (
    <Modal open title={t(coupon ? "coupons.editTitle" : "coupons.createTitle")} onCancel={onClose} footer={null} width={720} maskClosable={false}>
      {bannerError ? <Alert type="error" showIcon message={bannerError.message} style={{ marginBottom: 16 }} /> : null}
      <Form<CouponFormValues>
        form={form}
        name="coupon"
        layout="vertical"
        onFinish={onFinish}
        disabled={save.isPending}
        initialValues={coupon ? fromCoupon(coupon) : emptyCoupon()}
      >
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="code" label={t("coupons.form.code")} extra={t("coupons.form.codeHelp")} rules={required}>
              <Input disabled={coupon !== undefined} style={{ textTransform: "uppercase" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="status" label={t("coupons.form.status")} rules={required}>
              <Select
                options={[
                  { value: "ACTIVE", label: t("coupons.status.ACTIVE") },
                  { value: "DISABLED", label: t("coupons.status.DISABLED") },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="discountType" label={t("coupons.form.discountType")} rules={required}>
              <Select
                options={[
                  { value: "PERCENT", label: t("coupons.discountType.PERCENT") },
                  { value: "AMOUNT", label: t("coupons.discountType.AMOUNT") },
                  { value: "WAIVER", label: t("coupons.discountType.WAIVER") },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="discountValue"
              label={t("coupons.form.discountValue")}
              dependencies={["discountType"]}
              rules={[
                {
                  validator: (_: unknown, value: string | undefined) => {
                    if (parseDiscountValue(discountType, value) !== null) {
                      return Promise.resolve();
                    }
                    const key = discountType === "PERCENT" ? "coupons.form.percentInvalid" : "coupons.form.amountInvalid";
                    return Promise.reject(new Error(t(key)));
                  },
                },
              ]}
            >
              <Input
                inputMode="decimal"
                disabled={discountType === "WAIVER"}
                addonBefore={discountType === "AMOUNT" ? "$" : undefined}
                addonAfter={discountType === "PERCENT" ? "%" : undefined}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={12} md={12}>
            <Form.Item name="quota" label={t("coupons.form.quota")} rules={required}>
              <InputNumber min={1} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={12}>
            <Form.Item name="minRunners" label={t("coupons.form.minRunners")} extra={t("coupons.form.minRunnersHelp")}>
              <InputNumber min={1} max={10} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="validFrom" label={t("coupons.form.validFrom")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="validUntil" label={t("coupons.form.validUntil")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Space>
          <Button onClick={onClose}>{t("coupons.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="coupon-submit">
            {t("coupons.submit")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}
