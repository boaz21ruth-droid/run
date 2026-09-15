import { ApiError, formatUsd } from "@werun/api-client";
import { Alert, Button, Card, Col, Descriptions, Image, Row, Space, Tag, Typography, type DescriptionsProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { PERM_PROOF_REVIEW, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { formatDateTime } from "../orders/format";
import { OrderOverviewCard, OrderParticipantsCard, OrderProofsCard } from "../orders/OrderSections";
import { OrderStatusTag } from "../orders/OrderStatusTag";
import { ApproveProofModal } from "../proofs/ApproveProofModal";
import { ProofStatusTag } from "../proofs/ProofStatusTag";
import { RejectProofModal } from "../proofs/RejectProofModal";
import { adminFileUrl, useProof } from "../proofs/queries";

export function ProofDetailPage() {
  const { id = "" } = useParams();
  const proofId = Number(id);
  const { t } = useTranslation("admin");
  const navigate = useNavigate();
  const { data: me } = useMe();
  const detail = useProof(proofId);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const canReview = can(me?.permissions, PERM_PROOF_REVIEW, "write");

  const backButton = <Button onClick={() => void navigate("/proofs")}>{t("proofs.detail.back")}</Button>;

  if (!Number.isInteger(proofId) || proofId <= 0 || (detail.error instanceof ApiError && detail.error.status === 404)) {
    return <Alert type="warning" showIcon message={t("proofs.detail.notFound")} action={backButton} />;
  }
  if (detail.isError) {
    return <Alert type="error" showIcon message={detail.error.message} action={backButton} />;
  }
  if (detail.isPending) {
    return <Card loading />;
  }

  const { proof, order } = detail.data;
  const reviewable = canReview && proof.status === "SUBMITTED" && order.status === "PROOF_SUBMITTED";

  const declaredItems: DescriptionsProps["items"] = [
    {
      key: "declaredAmount",
      label: t("proofs.detail.declaredAmount"),
      children: (
        <Typography.Text strong type={proof.declaredAmountCents < order.amountCents ? "danger" : undefined}>
          {formatUsd(proof.declaredAmountCents)}
        </Typography.Text>
      ),
    },
    { key: "amount", label: t("orders.detail.amount"), children: formatUsd(order.amountCents) },
    {
      key: "txnRef",
      label: t("proofs.col.txnRef"),
      children: (
        <Typography.Text code copyable>
          {proof.bankTxnRef}
        </Typography.Text>
      ),
    },
    { key: "declaredPaidAt", label: t("proofs.detail.declaredPaidAt"), children: formatDateTime(proof.declaredPaidAt) },
    { key: "payerName", label: t("proofs.detail.payerName"), children: proof.payerName ?? "—" },
    { key: "submittedAt", label: t("proofs.detail.submittedAt"), children: formatDateTime(proof.createdAt) },
    { key: "orderStatus", label: t("orders.col.status"), children: <OrderStatusTag status={order.status} /> },
  ];
  if (proof.reviewedAt) {
    declaredItems.push({ key: "reviewedAt", label: t("proofs.detail.reviewedAt"), children: formatDateTime(proof.reviewedAt) });
  }
  if (proof.rejectCode) {
    declaredItems.push(
      { key: "rejectCode", label: t("proofs.reject.code"), children: t(`proofs.rejectCode.${proof.rejectCode}`) },
      { key: "rejectReason", label: t("proofs.detail.rejectReason"), children: proof.rejectReason ?? "—" },
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Space wrap>
          {backButton}
          <Typography.Title level={3} style={{ margin: 0 }}>
            {proof.proofNo}
          </Typography.Title>
          <ProofStatusTag status={proof.status} testId="proof-status" />
          {proof.dupFileHit ? <Tag color="orange">{t("proofs.dupTag")}</Tag> : null}
        </Space>
        {reviewable ? (
          <Space>
            <Button danger data-testid="proof-reject-open" onClick={() => setDialog("reject")}>
              {t("proofs.reject.open")}
            </Button>
            <Button type="primary" data-testid="proof-approve-open" onClick={() => setDialog("approve")}>
              {t("proofs.approve.open")}
            </Button>
          </Space>
        ) : null}
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card title={t("proofs.detail.screenshot")}>
            <Image
              data-testid="proof-image"
              src={adminFileUrl(proof.fileId)}
              alt={t("proofs.detail.screenshot")}
              width="100%"
              style={{ maxHeight: 640, objectFit: "contain" }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Card title={t("proofs.detail.declared")}>
              <Descriptions column={{ xs: 1, md: 2 }} items={declaredItems} />
            </Card>
            <OrderOverviewCard order={order} />
          </Space>
        </Col>
      </Row>

      <OrderParticipantsCard order={order} />
      <OrderProofsCard order={order} currentProofId={proof.id} />

      {dialog === "approve" ? (
        <ApproveProofModal proof={proof} amountCents={order.amountCents} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "reject" ? <RejectProofModal proofId={proof.id} onClose={() => setDialog(null)} /> : null}
    </Space>
  );
}
