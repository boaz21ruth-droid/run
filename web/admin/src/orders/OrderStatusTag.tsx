import { Tag } from "antd";
import { useTranslation } from "react-i18next";
import type { AdminOrderStatus } from "./queries";

const COLORS: Record<AdminOrderStatus, string> = {
  PENDING_PAYMENT: "gold",
  PROOF_SUBMITTED: "blue",
  PROOF_REJECTED: "red",
  PAID: "green",
  PARTIALLY_REFUNDED: "purple",
  REFUNDED: "purple",
  EXPIRED: "default",
  CANCELLED: "default",
};

export function OrderStatusTag({ status, testId }: { status: AdminOrderStatus; testId?: string }) {
  const { t } = useTranslation("admin");
  return (
    <Tag color={COLORS[status]} data-testid={testId} data-status={status}>
      {t(`orders.status.${status}`)}
    </Tag>
  );
}
