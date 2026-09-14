import { ArrowLeftOutlined } from "@ant-design/icons";
import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, Button, Card, Descriptions, Space, Spin, Table, Tabs, Tag, Typography, type TableProps, type TabsProps } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router";
import { PERM_EVENT_CONFIG, PERM_PRICE_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { RegistrationCard } from "../events/RegistrationCard";
import { pickText } from "../events/localize";
import { useAdminEvent } from "../events/queries";
import { PricingTab } from "../pricing/PricingTab";

type AdminCategory = Schemas["AdminCategory"];

export function EventDetailPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const params = useParams();
  const eventId = Number(params.id);
  const { data: me } = useMe();
  const query = useAdminEvent(eventId);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return <Navigate to="/events" replace />;
  }
  if (query.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message={query.error.message}
        action={
          <Button size="small" onClick={() => void navigate("/events")}>
            {t("eventDetail.back")}
          </Button>
        }
      />
    );
  }
  if (!query.data) {
    return <Spin />;
  }

  const event = query.data;
  const canWriteEvent = can(me?.permissions, PERM_EVENT_CONFIG, "write");

  const categoryColumns: TableProps<AdminCategory>["columns"] = [
    { title: t("eventDetail.categories.code"), dataIndex: "code", key: "code" },
    { title: t("eventDetail.categories.name"), key: "name", render: (_, category) => pickText(category.name, lang) },
    { title: t("eventDetail.categories.distanceM"), dataIndex: "distanceM", key: "distanceM" },
    { title: t("eventDetail.categories.capacity"), dataIndex: "capacity", key: "capacity" },
  ];

  const items: NonNullable<TabsProps["items"]> = [
    {
      key: "basic",
      label: <span data-testid="event-tab-basic">{t("eventDetail.tabBasic")}</span>,
      children: (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Card title={t("eventDetail.info.title")}>
            <Descriptions
              column={{ xs: 1, md: 2 }}
              items={[
                { key: "slug", label: t("eventDetail.info.slug"), children: event.slug },
                { key: "eventType", label: t("eventDetail.info.eventType"), children: t(`eventType.${event.eventType}`) },
                {
                  key: "status",
                  label: t("eventDetail.info.status"),
                  children: (
                    <Tag color={event.status === "PUBLISHED" ? "green" : "default"}>{t(`status.${event.status}`)}</Tag>
                  ),
                },
                { key: "raceDate", label: t("eventDetail.info.raceDate"), children: event.raceDate },
                { key: "city", label: t("eventDetail.info.city"), children: event.city },
                { key: "timezone", label: t("eventDetail.info.timezone"), children: event.timezone },
              ]}
            />
          </Card>
          <Card title={t("eventDetail.categories.title")}>
            <Table<AdminCategory>
              rowKey="id"
              columns={categoryColumns}
              dataSource={event.categories}
              pagination={false}
              scroll={{ x: 560 }}
            />
          </Card>
          <RegistrationCard event={event} canWrite={canWriteEvent} />
        </Space>
      ),
    },
  ];
  if (can(me?.permissions, PERM_PRICE_CONFIG, "read")) {
    items.push({
      key: "pricing",
      label: <span data-testid="event-tab-pricing">{t("eventDetail.tabPricing")}</span>,
      children: <PricingTab event={event} />,
    });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => void navigate("/events")} style={{ paddingInline: 0 }}>
        {t("eventDetail.back")}
      </Button>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {pickText(event.name, lang)}
      </Typography.Title>
      <Tabs items={items} />
    </Space>
  );
}
