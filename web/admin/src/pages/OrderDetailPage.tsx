import { ApiError } from "@werun/api-client";
import { Alert, Button, Card, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import {
  OrderAmountsCard,
  OrderOverviewCard,
  OrderParticipantsCard,
  OrderProofsCard,
  OrderReceiptsCard,
} from "../orders/OrderSections";
import { OrderStatusTag } from "../orders/OrderStatusTag";
import { useAdminOrder } from "../orders/queries";

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const orderId = Number(id);
  const { t } = useTranslation("admin");
  const navigate = useNavigate();
  const order = useAdminOrder(orderId);

  const backButton = <Button onClick={() => void navigate("/orders")}>{t("orders.detail.back")}</Button>;

  if (!Number.isInteger(orderId) || orderId <= 0 || (order.error instanceof ApiError && order.error.status === 404)) {
    return <Alert type="warning" showIcon message={t("orders.detail.notFound")} action={backButton} />;
  }
  if (order.isError) {
    return <Alert type="error" showIcon message={order.error.message} action={backButton} />;
  }
  if (order.isPending) {
    return <Card loading />;
  }

  const data = order.data;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        {backButton}
        <Typography.Title level={3} style={{ margin: 0 }}>
          {data.orderNo}
        </Typography.Title>
        <OrderStatusTag status={data.status} testId="order-status" />
      </Space>
      <OrderOverviewCard order={data} />
      <OrderAmountsCard order={data} />
      <OrderParticipantsCard order={data} />
      <OrderProofsCard order={data} />
      <OrderReceiptsCard order={data} />
    </Space>
  );
}
