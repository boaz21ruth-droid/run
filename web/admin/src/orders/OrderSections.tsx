import { formatUsd, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Card, Descriptions, Table, Tag, Typography, type DescriptionsProps, type TableProps } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { PERM_PROOF_REVIEW, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { ProofStatusTag } from "../proofs/ProofStatusTag";
import { formatDateTime } from "./format";

type OrderDetail = Schemas["AdminOrderDetail"];
type Participant = OrderDetail["participants"][number];
type ProofItem = OrderDetail["proofs"][number];
type Receipt = OrderDetail["receipts"][number];

const REGISTRATION_COLORS: Record<Participant["registrationStatus"], string> = {
  PENDING: "gold",
  CONFIRMED: "green",
  CANCELLED: "default",
};

const MATCH_COLORS: Record<Receipt["matchStatus"], string> = {
  APPLIED: "green",
  EXCEPTION: "orange",
  UNMATCHED: "default",
};

export function OrderOverviewCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const items: DescriptionsProps["items"] = [
    { key: "orderNo", label: t("orders.detail.orderNo"), children: <Typography.Text copyable>{order.orderNo}</Typography.Text> },
    { key: "event", label: t("orders.detail.event"), children: pickText(order.eventName, lang) },
    { key: "buyer", label: t("orders.detail.buyer"), children: order.buyerName },
    { key: "phone", label: t("orders.detail.phone"), children: order.buyerPhone },
    { key: "createdAt", label: t("orders.detail.createdAt"), children: formatDateTime(order.createdAt) },
    { key: "deadlineAt", label: t("orders.detail.deadlineAt"), children: formatDateTime(order.deadlineAt) },
    { key: "paidAt", label: t("orders.detail.paidAt"), children: formatDateTime(order.paidAt) },
    {
      key: "paymentAccount",
      label: t("orders.detail.paymentAccount"),
      children: `${order.paymentAccount.name} · ${order.paymentAccount.accountNoMasked}`,
    },
  ];
  return (
    <Card title={t("orders.detail.title")}>
      <Descriptions column={{ xs: 1, md: 2 }} items={items} />
    </Card>
  );
}

export function OrderAmountsCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const items: DescriptionsProps["items"] = [
    { key: "listAmount", label: t("orders.detail.listAmount"), children: formatUsd(order.listAmountCents) },
  ];
  if (order.coupon) {
    items.push({
      key: "coupon",
      label: t("orders.detail.couponDiscount", { code: order.coupon.code }),
      children: (
        <span>
          {formatUsd(-order.coupon.discountCents)} <Tag>{t(`orders.couponState.${order.coupon.state}`)}</Tag>
        </span>
      ),
    });
  }
  items.push(
    {
      key: "identOffset",
      label: t("orders.detail.identOffset"),
      children: <span data-testid="order-ident-offset">{formatUsd(order.identOffsetCents)}</span>,
    },
    { key: "discount", label: t("orders.detail.discount"), children: formatUsd(-order.discountCents) },
    {
      key: "amount",
      label: t("orders.detail.amount"),
      children: (
        <span data-testid="order-amount">
          <Typography.Text strong>{formatUsd(order.amountCents)}</Typography.Text>
        </span>
      ),
    },
  );
  return (
    <Card title={t("orders.detail.amounts")}>
      <Descriptions column={1} items={items} />
    </Card>
  );
}

export function OrderParticipantsCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const columns: TableProps<Participant>["columns"] = [
    { title: t("orders.participant.name"), dataIndex: "fullName", key: "fullName" },
    { title: t("orders.participant.category"), key: "category", render: (_, p) => pickText(p.categoryName, lang) },
    { title: t("orders.participant.regNo"), dataIndex: "regNo", key: "regNo" },
    { title: t("orders.participant.listPrice"), key: "listPrice", align: "right", render: (_, p) => formatUsd(p.listPriceCents) },
    { title: t("orders.participant.paid"), key: "paid", align: "right", render: (_, p) => formatUsd(p.paidCents) },
    {
      title: t("orders.participant.status"),
      key: "status",
      render: (_, p) => (
        <Tag color={REGISTRATION_COLORS[p.registrationStatus]}>{t(`orders.registrationStatus.${p.registrationStatus}`)}</Tag>
      ),
    },
  ];
  return (
    <Card title={t("orders.detail.participants")}>
      <Table<Participant>
        rowKey="registrationId"
        size="small"
        columns={columns}
        dataSource={order.participants}
        pagination={false}
        scroll={{ x: 640 }}
      />
    </Card>
  );
}

export function OrderProofsCard({ order, currentProofId }: { order: OrderDetail; currentProofId?: number }) {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const canOpenProof = can(me?.permissions, PERM_PROOF_REVIEW, "read");
  const columns: TableProps<ProofItem>["columns"] = [
    {
      title: t("proofs.col.proofNo"),
      key: "proofNo",
      render: (_, p) => (
        <span>
          {canOpenProof && p.id !== currentProofId ? <Link to={`/proofs/${p.id}`}>{p.proofNo}</Link> : p.proofNo}
          {p.id === currentProofId ? <Tag style={{ marginInlineStart: 8 }}>{t("proofs.detail.current")}</Tag> : null}
        </span>
      ),
    },
    { title: t("proofs.col.status"), key: "status", render: (_, p) => <ProofStatusTag status={p.status} /> },
    { title: t("proofs.col.txnRef"), dataIndex: "bankTxnRef", key: "bankTxnRef" },
    { title: t("proofs.col.declared"), key: "declared", align: "right", render: (_, p) => formatUsd(p.declaredAmountCents) },
    {
      title: t("proofs.reject.code"),
      key: "rejectCode",
      render: (_, p) => (p.rejectCode ? t(`proofs.rejectCode.${p.rejectCode}`) : "—"),
    },
    { title: t("proofs.detail.submittedAt"), key: "createdAt", render: (_, p) => formatDateTime(p.createdAt) },
    { title: t("proofs.detail.reviewedAt"), key: "reviewedAt", render: (_, p) => formatDateTime(p.reviewedAt) },
  ];
  return (
    <Card title={t("orders.detail.proofs")}>
      <Table<ProofItem>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={order.proofs}
        pagination={false}
        scroll={{ x: 760 }}
        locale={{ emptyText: t("proofs.empty") }}
      />
    </Card>
  );
}

export function OrderReceiptsCard({ order }: { order: OrderDetail }) {
  const { t } = useTranslation("admin");
  const columns: TableProps<Receipt>["columns"] = [
    { title: t("orders.receipt.txnRef"), dataIndex: "txnRef", key: "txnRef" },
    { title: t("orders.receipt.amount"), key: "amount", align: "right", render: (_, r) => formatUsd(r.amountCents) },
    { title: t("orders.receipt.receivedAt"), key: "receivedAt", render: (_, r) => formatDateTime(r.receivedAt) },
    {
      title: t("orders.receipt.match"),
      key: "match",
      render: (_, r) => <Tag color={MATCH_COLORS[r.matchStatus]}>{t(`orders.matchStatus.${r.matchStatus}`)}</Tag>,
    },
  ];
  return (
    <Card title={t("orders.detail.receipts")}>
      <Table<Receipt> rowKey="id" size="small" columns={columns} dataSource={order.receipts} pagination={false} scroll={{ x: 560 }} />
    </Card>
  );
}
