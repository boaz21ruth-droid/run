import { SendOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { Alert, App as AntdApp, Button, Card, Input, Modal, Segmented, Space, Table, Tag, Typography, type TableProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { PERM_EVENT_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { formatInTimezone } from "../time/eventTime";

type AdminEvent = Schemas["AdminEvent"];
type Audience = Schemas["BroadcastAudience"];
type Item = Schemas["BroadcastItem"];

const MAX_BODY = 500;
const boardKey = (eventId: number) => ["admin", "broadcasts", eventId] as const;

/** 赛事详情的「发通知」页：选人群、写一条消息，Telegram 推送并显示在跑者「我的赛事」（v8 设计稿 10） */
export function BroadcastTab({ event }: { event: AdminEvent }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const { data: me } = useMe();
  const canWrite = can(me?.permissions, PERM_EVENT_CONFIG, "write");
  const [audience, setAudience] = useState<Audience>("PAID");
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const board = useQuery({
    queryKey: boardKey(event.id),
    queryFn: async () => unwrap(await api.GET("/admin/events/{id}/broadcasts", { params: { path: { id: event.id } } })),
  });
  const send = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/admin/events/{id}/broadcasts", {
          params: { path: { id: event.id } },
          body: { audience, body: body.trim() },
        }),
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(boardKey(event.id), data);
      void message.success(t("broadcast.sent", { n: data.items[0]?.recipientCount ?? 0 }));
      setBody("");
      setConfirming(false);
    },
    onError: (error) => {
      setConfirming(false);
      void message.error(error.message);
    },
  });

  const countOf = (a: Audience) => board.data?.audiences.find((x) => x.audience === a)?.count ?? 0;
  const recipients = countOf(audience);
  const columns: TableProps<Item>["columns"] = [
    {
      title: t("broadcast.col.time"),
      key: "createdAt",
      width: 170,
      render: (_, it) => formatInTimezone(it.createdAt, event.timezone),
    },
    {
      title: t("broadcast.col.audience"),
      key: "audience",
      width: 120,
      render: (_, it) => <Tag>{t(`broadcast.audience.${it.audience}`)}</Tag>,
    },
    {
      title: t("broadcast.col.body"),
      key: "body",
      render: (_, it) => (
        <Typography.Paragraph ellipsis={{ rows: 2, expandable: true }} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {it.body}
        </Typography.Paragraph>
      ),
    },
    {
      title: t("broadcast.col.delivery"),
      key: "delivery",
      width: 190,
      render: (_, it) => (
        <Space direction="vertical" size={0}>
          <span>{t("broadcast.recipients", { n: it.recipientCount })}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("broadcast.delivery", { sent: it.sentCount, failed: it.failedCount })}
          </Typography.Text>
        </Space>
      ),
    },
    { title: t("broadcast.col.sender"), dataIndex: "senderName", key: "sender", width: 120 },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card title={t("broadcast.title")}>
        {board.isError ? <Alert type="error" showIcon message={board.error.message} style={{ marginBottom: 12 }} /> : null}
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Segmented<Audience>
            value={audience}
            onChange={setAudience}
            options={(["PAID", "PENDING", "ELITE", "VOLUNTEERS"] as const).map((a) => ({
              value: a,
              label: <span data-testid={`broadcast-audience-${a}`}>{`${t(`broadcast.audience.${a}`)} · ${countOf(a)}`}</span>,
            }))}
          />
          <Input.TextArea
            rows={4}
            maxLength={MAX_BODY}
            showCount
            value={body}
            disabled={!canWrite}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("broadcast.placeholder")}
            data-testid="broadcast-body"
          />
          <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
            <Typography.Text type="secondary">{t("broadcast.hint")}</Typography.Text>
            {canWrite ? (
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={body.trim() === "" || recipients === 0}
                onClick={() => setConfirming(true)}
                data-testid="broadcast-send"
              >
                {t("broadcast.send")}
              </Button>
            ) : null}
          </Space>
        </Space>
      </Card>
      <Card title={t("broadcast.history")}>
        <Table<Item>
          rowKey="id"
          columns={columns}
          dataSource={board.data?.items ?? []}
          loading={board.isPending}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 800 }}
          locale={{ emptyText: t("broadcast.empty") }}
        />
      </Card>
      {confirming ? (
        <Modal
          open
          title={t("broadcast.confirmTitle", { n: recipients, audience: t(`broadcast.audience.${audience}`) })}
          onCancel={() => setConfirming(false)}
          onOk={() => send.mutate()}
          okText={t("broadcast.send")}
          okButtonProps={{ loading: send.isPending, "data-testid": "broadcast-confirm" }}
          cancelText={t("broadcast.cancel")}
        >
          <Typography.Paragraph type="secondary">{t("broadcast.confirmBody")}</Typography.Paragraph>
          <Typography.Paragraph style={{ whiteSpace: "pre-wrap", padding: 12, background: "rgba(0,0,0,0.03)", borderRadius: 8 }}>
            {body.trim()}
          </Typography.Paragraph>
        </Modal>
      ) : null}
    </Space>
  );
}
