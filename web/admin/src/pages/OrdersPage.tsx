import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, Button, Form, Input, Select, Space, Table, Typography, type TableProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { PERM_EVENT_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { formatDateTime, rowProps } from "../orders/format";
import { OrderStatusTag } from "../orders/OrderStatusTag";
import {
  ORDER_PAGE_SIZE,
  ORDER_STATUSES,
  useAdminOrders,
  useEventOptions,
  type AdminOrderFilter,
  type AdminOrderStatus,
} from "../orders/queries";

type OrderSummary = Schemas["AdminOrderSummary"];

interface FilterValues {
  eventId?: number;
  status?: AdminOrderStatus;
  q?: string;
}

export function OrdersPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const canSeeEvents = can(me?.permissions, PERM_EVENT_CONFIG, "read");
  const events = useEventOptions(canSeeEvents);
  const [form] = Form.useForm<FilterValues>();
  const [filter, setFilter] = useState<AdminOrderFilter>({ page: 1 });
  const orders = useAdminOrders(filter);

  const columns: TableProps<OrderSummary>["columns"] = [
    {
      title: t("orders.col.orderNo"),
      key: "orderNo",
      render: (_, order) => <Typography.Text strong>{order.orderNo}</Typography.Text>,
    },
    { title: t("orders.col.event"), key: "event", render: (_, order) => pickText(order.eventName, lang) },
    { title: t("orders.col.participants"), dataIndex: "participantCount", key: "participantCount", align: "right" },
    { title: t("orders.col.amount"), key: "amount", align: "right", render: (_, order) => formatUsd(order.amountCents) },
    { title: t("orders.col.status"), key: "status", render: (_, order) => <OrderStatusTag status={order.status} /> },
    { title: t("orders.col.createdAt"), key: "createdAt", render: (_, order) => formatDateTime(order.createdAt) },
  ];

  const onFinish = (values: FilterValues) => {
    const q = values.q?.trim();
    setFilter({ eventId: values.eventId, status: values.status, q: q ? q : undefined, page: 1 });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t("orders.title")}
      </Typography.Title>

      <Form<FilterValues> form={form} name="orderFilter" layout="inline" onFinish={onFinish} style={{ rowGap: 12 }}>
        {canSeeEvents ? (
          <Form.Item name="eventId" label={t("orders.filter.event")}>
            <Select
              allowClear
              style={{ minWidth: 220 }}
              loading={events.isPending}
              options={(events.data ?? []).map((event) => ({ value: event.id, label: pickText(event.name, lang) }))}
            />
          </Form.Item>
        ) : null}
        <Form.Item name="status" label={t("orders.filter.status")}>
          <Select
            allowClear
            style={{ minWidth: 180 }}
            options={ORDER_STATUSES.map((status) => ({ value: status, label: t(`orders.status.${status}`) }))}
          />
        </Form.Item>
        <Form.Item name="q">
          <Input allowClear placeholder={t("orders.filter.q")} style={{ width: 240 }} />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" data-testid="order-filter-submit">
            {t("orders.filter.submit")}
          </Button>
          <Button
            onClick={() => {
              form.resetFields();
              setFilter({ page: 1 });
            }}
          >
            {t("orders.filter.reset")}
          </Button>
        </Space>
      </Form>

      {orders.isError ? <Alert type="error" showIcon message={orders.error.message} /> : null}

      <Table<OrderSummary>
        rowKey="id"
        columns={columns}
        dataSource={orders.data?.items ?? []}
        loading={orders.isFetching}
        locale={{ emptyText: t("orders.empty") }}
        scroll={{ x: 900 }}
        pagination={{
          current: filter.page,
          pageSize: ORDER_PAGE_SIZE,
          total: orders.data?.total ?? 0,
          showSizeChanger: false,
          showTotal: (total) => t("orders.total", { total }),
          onChange: (page) => setFilter((previous) => ({ ...previous, page })),
        }}
        onRow={(order) =>
          rowProps(`order-row-${order.orderNo}`, {
            onClick: () => void navigate(`/orders/${order.id}`),
            style: { cursor: "pointer" },
          })
        }
      />
    </Space>
  );
}
