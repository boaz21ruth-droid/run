import type { Schemas } from "@werun/api-client";
import { Tag } from "antd";
import { useTranslation } from "react-i18next";

type ProofStatus = Schemas["Proof"]["status"];

const COLORS: Record<ProofStatus, string> = {
  SUBMITTED: "gold",
  APPROVED: "green",
  REJECTED: "red",
  WITHDRAWN: "default",
};

export function ProofStatusTag({ status, testId }: { status: ProofStatus; testId?: string }) {
  const { t } = useTranslation("admin");
  return (
    <Tag color={COLORS[status]} data-testid={testId} data-status={status}>
      {t(`proofs.status.${status}`)}
    </Tag>
  );
}
