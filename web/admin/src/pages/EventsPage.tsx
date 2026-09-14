import { PlusOutlined } from "@ant-design/icons";
import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, App as AntdApp, Button, Space, Table, Tag, Typography, type TableProps } from "antd";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { PERM_EVENT_CONFIG, PERM_EVENT_PUBLISH, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { useAdminEvents, usePublishEvent } from "../events/queries";

type AdminEvent = Schemas["AdminEvent"];

export function EventsPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { data: me } = useMe();
  const events = useAdminEvents();
  const publish = usePublishEvent();

  const canCreate = can(me?.permissions, PERM_EVENT_CONFIG, "write");
  const canPublish = can(me?.permissions, PERM_EVENT_PUBLISH, "write");

  const columns: TableProps<AdminEvent>["columns"] = [
    {
      title: t("events.col.name"),
      key: "name",
      render: (_, event) => (
        <Link to={`/events/${event.id}`} data-testid={`event-open-${event.slug}`}>
          {pickText(event.name, lang)}
        </Link>
      ),
    },
    { title: t("events.col.date"), dataIndex: "raceDate", key: "raceDate" },
    { title: t("events.col.city"), dataIndex: "city", key: "city" },
    {
      title: t("events.col.status"),
      key: "status",
      render: (_, event) => (
        <Tag color={event.status === "PUBLISHED" ? "green" : "default"}>{t(`status.${event.status}`)}</Tag>
      ),
    },
    {
      title: t("events.col.actions"),
      key: "actions",
      render: (_, event) =>
        canPublish && event.status === "DRAFT" ? (
          <Button
            size="small"
            type="primary"
            data-testid={`event-publish-${event.slug}`}
            loading={publish.isPending && publish.variables === event.id}
            onClick={() =>
              publish.mutate(event.id, {
                onSuccess: () => void message.success(t("events.publishedToast")),
                onError: (error) => void message.error(error.message),
              })
            }
          >
            {t("events.publish")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t("events.title")}
        </Typography.Title>
        {canCreate ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            data-testid="event-create-button"
            onClick={() => void navigate("/events/new")}
          >
            {t("events.create")}
          </Button>
        ) : null}
      </Space>
      {events.isError ? (
        <Alert
          type="error"
          showIcon
          message={t("common:state.error")}
          action={
            <Button size="small" onClick={() => void events.refetch()}>
              {t("common:action.retry")}
            </Button>
          }
        />
      ) : null}
      <Table<AdminEvent>
        rowKey="id"
        columns={columns}
        dataSource={events.data ?? []}
        loading={events.isPending}
        pagination={false}
        locale={{ emptyText: t("events.empty") }}
        scroll={{ x: 720 }}
      />
    </Space>
  );
}
