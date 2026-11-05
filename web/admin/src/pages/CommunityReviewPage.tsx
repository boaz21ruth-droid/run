import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { Alert, App as AntdApp, Button, Input, Modal, Segmented, Select, Space, Table, Tag, Typography, type TableProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { PERM_CONTENT_MANAGE, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { formatInTimezone } from "../time/eventTime";

type Row = Schemas["AdminCommunityActivity"];
type Status = Schemas["CommunityStatus"];
type RejectCode = Schemas["RejectCommunityActivityRequest"]["code"];

const TIMEZONE = "Asia/Phnom_Penh";
const REJECT_CODES: RejectCode[] = ["R01", "R02", "R03", "R04", "R05"];
const listKey = (status: Status | "ALL") => ["admin", "community", status] as const;

/** 跑团活动审核（设计稿第 07 屏的后台）：通过 / 不通过、紧急冻结 / 解冻 */
export function CommunityReviewPage() {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const { data: me } = useMe();
  const canWrite = can(me?.permissions, PERM_CONTENT_MANAGE, "write");
  const [status, setStatus] = useState<Status | "ALL">("REVIEWING");
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [code, setCode] = useState<RejectCode>("R01");
  const [freezing, setFreezing] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const list = useQuery({
    queryKey: listKey(status),
    queryFn: async () =>
      unwrap(await api.GET("/admin/community/activities", { params: { query: status === "ALL" ? {} : { status } } })).items,
  });
  const act = useMutation({
    mutationFn: async (vars: { id: number; action: "approve" | "reject" | "freeze" | "unfreeze"; code?: RejectCode; reason?: string }) => {
      const path = { params: { path: { id: vars.id } } };
      switch (vars.action) {
        case "approve":
          return unwrap(await api.POST("/admin/community/activities/{id}/approve", path));
        case "reject":
          return unwrap(await api.POST("/admin/community/activities/{id}/reject", { ...path, body: { code: vars.code ?? "R01" } }));
        case "freeze":
          return unwrap(await api.POST("/admin/community/activities/{id}/freeze", { ...path, body: { reason: vars.reason ?? "" } }));
        default:
          return unwrap(await api.POST("/admin/community/activities/{id}/unfreeze", path));
      }
    },
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "community"] });
      void message.success(t(`community.done.${vars.action}`));
      setRejecting(null);
      setFreezing(null);
      setReason("");
    },
    onError: (error) => void message.error(error.message),
  });

  const columns: TableProps<Row>["columns"] = [
    {
      title: t("community.col.activity"),
      key: "activity",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6} wrap>
            <Typography.Text strong>{r.activity.title}</Typography.Text>
            <Tag>{t(`community.tags.${r.activity.tag}`)}</Tag>
            {r.activity.hostName ? <Tag color="blue">{r.activity.hostName}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatInTimezone(r.activity.startsAt, TIMEZONE)} · {r.activity.city} · {r.activity.location} · {r.activity.meetPoint}
          </Typography.Text>
          <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, expandable: true }} style={{ margin: 0, maxWidth: 360 }}>
            {r.activity.body}
          </Typography.Paragraph>
        </Space>
      ),
    },
    {
      title: t("community.col.author"),
      key: "author",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.activity.authorName}</span>
          {r.authorTelegram ? (
            <Typography.Link href={`https://t.me/${r.authorTelegram}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              @{r.authorTelegram}
            </Typography.Link>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[r.contactTelegram ? `TG @${r.contactTelegram}` : null, r.contactPhone].filter(Boolean).join(" · ")}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("community.col.spots"),
      key: "spots",
      render: (_, r) => `${r.activity.joinedCount} / ${r.activity.capacity} · ${r.activity.feeNote}`,
    },
    {
      title: t("community.col.status"),
      key: "status",
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={{ REVIEWING: "orange", PUBLISHED: "green" }[r.activity.status as string] ?? "default"}>
            {t(`community.status.${r.activity.status}`)}
          </Tag>
          {r.activity.rejectCode ? <Typography.Text type="secondary">{t(`community.reject.${r.activity.rejectCode}`)}</Typography.Text> : null}
          {r.activity.frozen ? (
            <Tag color="red">
              {t("community.frozen")}
              {r.freezeReason ? ` · ${r.freezeReason}` : ""}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("community.col.actions"),
      key: "actions",
      render: (_, r) => {
        if (!canWrite) {
          return null;
        }
        const busy = act.isPending && act.variables?.id === r.activity.id;
        return (
          <Space wrap>
            {r.activity.status === "REVIEWING" ? (
              <>
                <Button
                  size="small"
                  type="primary"
                  loading={busy && act.variables?.action === "approve"}
                  onClick={() => act.mutate({ id: r.activity.id, action: "approve" })}
                  data-testid={`community-approve-${r.activity.id}`}
                >
                  {t("community.approve")}
                </Button>
                <Button size="small" onClick={() => setRejecting(r)} data-testid={`community-reject-${r.activity.id}`}>
                  {t("community.rejectAction")}
                </Button>
              </>
            ) : null}
            {r.activity.frozen ? (
              <Button
                size="small"
                onClick={() => act.mutate({ id: r.activity.id, action: "unfreeze" })}
                data-testid={`community-unfreeze-${r.activity.id}`}
              >
                {t("community.unfreeze")}
              </Button>
            ) : r.activity.status === "PUBLISHED" ? (
              <Button size="small" danger onClick={() => setFreezing(r)} data-testid={`community-freeze-${r.activity.id}`}>
                {t("community.freeze")}
              </Button>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t("community.title")}
      </Typography.Title>
      <Typography.Text type="secondary">{t("community.intro")}</Typography.Text>
      <Segmented<Status | "ALL">
        value={status}
        onChange={setStatus}
        options={(["REVIEWING", "PUBLISHED", "REJECTED", "CLOSED", "ALL"] as const).map((s) => ({
          value: s,
          label: s === "ALL" ? t("community.all") : t(`community.status.${s}`),
        }))}
        data-testid="community-status-filter"
      />
      {list.isError ? <Alert type="error" showIcon message={list.error.message} /> : null}
      <Table<Row>
        rowKey={(r) => r.activity.id}
        columns={columns}
        dataSource={list.data ?? []}
        loading={list.isPending}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 1000 }}
        locale={{ emptyText: t("community.empty") }}
      />
      {rejecting ? (
        <Modal
          open
          title={t("community.rejectTitle", { title: rejecting.activity.title })}
          onCancel={() => setRejecting(null)}
          onOk={() => act.mutate({ id: rejecting.activity.id, action: "reject", code })}
          okText={t("community.rejectAction")}
          okButtonProps={{ danger: true, loading: act.isPending, "data-testid": "community-reject-confirm" }}
          cancelText={t("community.cancel")}
        >
          <Select<RejectCode>
            style={{ width: "100%" }}
            value={code}
            onChange={setCode}
            options={REJECT_CODES.map((c) => ({ value: c, label: `${c} · ${t(`community.reject.${c}`)}` }))}
            data-testid="community-reject-code"
          />
        </Modal>
      ) : null}
      {freezing ? (
        <Modal
          open
          title={t("community.freezeTitle", { title: freezing.activity.title })}
          onCancel={() => setFreezing(null)}
          onOk={() => act.mutate({ id: freezing.activity.id, action: "freeze", reason: reason.trim() })}
          okText={t("community.freeze")}
          okButtonProps={{ danger: true, disabled: reason.trim() === "", loading: act.isPending, "data-testid": "community-freeze-confirm" }}
          cancelText={t("community.cancel")}
        >
          <Typography.Paragraph type="secondary">{t("community.freezeHint")}</Typography.Paragraph>
          <Input.TextArea
            rows={3}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("community.freezePlaceholder")}
            data-testid="community-freeze-reason"
          />
        </Modal>
      ) : null}
    </Space>
  );
}
