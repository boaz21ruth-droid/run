import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, Button, Space, Table, Tag, Typography, type TableProps } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { pickText } from "../events/localize";
import { rowProps, waitingParts } from "../orders/format";
import { ProofStatusTag } from "../proofs/ProofStatusTag";
import { useProofQueue } from "../proofs/queries";

type QueueItem = Schemas["ProofQueueItem"];

export function ProofsPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const queue = useProofQueue();
  const now = Date.now();

  const columns: TableProps<QueueItem>["columns"] = [
    {
      title: t("proofs.col.proofNo"),
      key: "proofNo",
      render: (_, item) => <Typography.Text strong>{item.proof.proofNo}</Typography.Text>,
    },
    { title: t("proofs.col.orderNo"), key: "orderNo", render: (_, item) => item.proof.orderNo },
    { title: t("proofs.col.event"), key: "event", render: (_, item) => pickText(item.eventName, lang) },
    { title: t("proofs.col.amount"), key: "amount", align: "right", render: (_, item) => formatUsd(item.amountCents) },
    {
      title: t("proofs.col.declared"),
      key: "declared",
      align: "right",
      render: (_, item) => (
        <Typography.Text type={item.proof.declaredAmountCents < item.amountCents ? "danger" : undefined}>
          {formatUsd(item.proof.declaredAmountCents)}
        </Typography.Text>
      ),
    },
    {
      title: t("proofs.col.txnRef"),
      key: "txnRef",
      render: (_, item) => (
        <Space size={4} wrap>
          <Typography.Text code>{item.proof.bankTxnRef}</Typography.Text>
          {item.proof.dupFileHit ? <Tag color="orange">{t("proofs.dupTag")}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t("proofs.col.waiting"),
      key: "waiting",
      render: (_, item) => {
        const { hours, minutes } = waitingParts(item.waitingSince, now);
        return (
          <Space size={4} wrap>
            <span>{hours > 0 ? t("proofs.waitingHours", { hours, minutes }) : t("proofs.waitingMinutes", { minutes })}</span>
            {item.overSla ? <Tag color="red">{t("proofs.overSla")}</Tag> : null}
          </Space>
        );
      },
    },
    { title: t("proofs.col.status"), key: "status", render: (_, item) => <ProofStatusTag status={item.proof.status} /> },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t("proofs.title")}
      </Typography.Title>
      {queue.isError ? (
        <Alert
          type="error"
          showIcon
          message={t("common:state.error")}
          action={
            <Button size="small" onClick={() => void queue.refetch()}>
              {t("common:action.retry")}
            </Button>
          }
        />
      ) : null}
      <Table<QueueItem>
        rowKey={(item) => item.proof.id}
        columns={columns}
        dataSource={queue.data ?? []}
        loading={queue.isPending}
        pagination={false}
        locale={{ emptyText: t("proofs.empty") }}
        scroll={{ x: 1000 }}
        onRow={(item) =>
          rowProps(
            `proof-row-${item.proof.proofNo}`,
            {
              onClick: () => void navigate(`/proofs/${item.proof.id}`),
              style: { cursor: "pointer", background: item.overSla ? "var(--stop-tint)" : undefined },
            },
            { "data-over-sla": String(item.overSla) },
          )
        }
      />
    </Space>
  );
}
