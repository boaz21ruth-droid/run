import { CheckCircleFilled, LockOutlined } from "@ant-design/icons";
import { ApiError } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, App as AntdApp, Button, Card, Checkbox, Input, Modal, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { pickText } from "../events/localize";
import { formatInTimezone } from "../time/eventTime";
import { useIssueRacepack, useUndoRacepack, type IssueVars, type RacepackEntry } from "./queries";

const bigNumber = {
  fontFamily: "var(--display)",
  fontWeight: 800,
  fontSize: 32,
  lineHeight: 1,
  color: "var(--brand)",
} as const;

interface Props {
  entry: RacepackEntry;
  timezone: string;
  canIssue: boolean;
  canUndo: boolean;
  /** 发放成功后回调：清空搜索、回到输入框，方便下一位 */
  onIssued: () => void;
}

/** 核销站上的一个人：可发放 / 已领取 / 被拦下三种样子 */
export function EntryCard({ entry, timezone, canIssue, canUndo, onIssued }: Props) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { message } = AntdApp.useApp();
  const issue = useIssueRacepack();
  const undo = useUndoRacepack();
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyName, setProxyName] = useState("");
  const [proxyChecked, setProxyChecked] = useState(false);
  const [idChecked, setIdChecked] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoReason, setUndoReason] = useState("");

  const testId = `racepack-entry-${entry.registrationId}`;
  const title = [entry.bib, entry.fullName].filter(Boolean).join(" · ");
  const needsId = entry.audience === "LOCAL" && !entry.idVerified;

  if (entry.blockReason) {
    return (
      <Card
        size="small"
        data-testid={testId}
        data-state="blocked"
        style={{ borderColor: "var(--stop-tint)", background: "var(--stop-tint)" }}
      >
        <Space align="start">
          <LockOutlined style={{ color: "var(--stop)", fontSize: 20, marginTop: 3 }} />
          <div>
            <Typography.Text strong style={{ color: "var(--stop)" }}>
              {title} · {t(`racepack.block.${entry.blockReason}`)}
            </Typography.Text>
            <div style={{ color: "var(--stop)", fontSize: 13 }}>{t("racepack.blockHint")}</div>
            <div style={{ color: "var(--stop)", fontSize: 12 }}>
              {t("racepack.reference")} {entry.orderNo}
            </div>
          </div>
        </Space>
      </Card>
    );
  }

  if (entry.picked) {
    const who = entry.proxyName ? t("racepack.byProxy", { name: entry.proxyName }) : t("racepack.bySelf");
    return (
      <Card size="small" data-testid={testId} data-state="picked">
        <Space align="start" style={{ width: "100%", justifyContent: "space-between" }}>
          <Space align="start">
            <CheckCircleFilled style={{ color: "var(--ink-mute)", fontSize: 20, marginTop: 3 }} />
            <div>
              <Typography.Text strong type="secondary">
                {title} · {t("racepack.picked")}
              </Typography.Text>
              <div style={{ fontSize: 13, color: "var(--ink-mute)" }}>
                {formatInTimezone(entry.pickedAt, timezone)} · {entry.pickedByName ?? "—"} · {who}
              </div>
            </div>
          </Space>
          {canUndo ? (
            <Button size="small" onClick={() => setUndoOpen(true)} data-testid={`${testId}-undo`}>
              {t("racepack.undo")}
            </Button>
          ) : null}
        </Space>
        <Modal
          open={undoOpen}
          title={t("racepack.undoTitle", { name: entry.fullName })}
          okText={t("racepack.undoConfirm")}
          okButtonProps={{ danger: true, disabled: undoReason.trim() === "", loading: undo.isPending }}
          onCancel={() => setUndoOpen(false)}
          onOk={() =>
            undo.mutate(
              { registrationId: entry.registrationId, reason: undoReason.trim(), clientEventId: crypto.randomUUID() },
              {
                onSuccess: () => {
                  setUndoOpen(false);
                  setUndoReason("");
                  void message.success(t("racepack.undone"));
                },
              },
            )
          }
        >
          <Input.TextArea
            value={undoReason}
            onChange={(e) => setUndoReason(e.target.value)}
            placeholder={t("racepack.undoReason")}
            maxLength={200}
            autoSize={{ minRows: 2 }}
            data-testid={`${testId}-undo-reason`}
          />
          {undo.error ? <Alert type="error" showIcon style={{ marginTop: 12 }} message={(undo.error as Error).message} /> : null}
        </Modal>
      </Card>
    );
  }

  const run = (vars: Omit<IssueVars, "registrationId">) =>
    issue.mutate(
      { registrationId: entry.registrationId, idVerified: idChecked || undefined, ...vars, clientEventId: crypto.randomUUID() },
      {
        onSuccess: (result) => {
          if (result.outcome === "ALREADY") {
            void message.warning(t("racepack.alreadyPicked", { name: entry.fullName }));
          } else {
            void message.success(t("racepack.issued", { name: entry.fullName }));
          }
          onIssued();
        },
      },
    );
  const blocked = !canIssue || (needsId && !idChecked);
  const error = issue.error instanceof ApiError || issue.error instanceof Error ? issue.error.message : null;

  return (
    <Card
      data-testid={testId}
      data-state="ready"
      style={{ borderColor: "var(--brand)", boxShadow: "0 0 0 2px var(--brand-tint)", borderRadius: "var(--r-lg)" }}
      styles={{ body: { padding: 16 } }}
    >
      <Space align="center" size={12}>
        {entry.bib ? <span style={bigNumber}>{entry.bib}</span> : null}
        <div>
          <div style={{ fontWeight: 700 }}>{entry.fullName}</div>
          <div style={{ fontSize: 12, color: "var(--ink-mute)" }}>
            {[
              pickText(entry.categoryName, lang),
              entry.tshirtSize ? t("racepack.tshirt", { size: entry.tshirtSize }) : null,
              `${t("racepack.reference")} ${entry.orderNo}`,
              entry.phoneLast4 ? t("racepack.phone", { last4: entry.phoneLast4 }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </Space>
      <Space size={[6, 6]} wrap style={{ marginTop: 12 }}>
        <Tag color="green">{t("racepack.paid")}</Tag>
        {entry.bib ? null : <Tag>{t("racepack.noBib")}</Tag>}
        {entry.audience === "LOCAL" ? (
          entry.idVerified ? (
            <Tag color="green">{t("racepack.idVerified")}</Tag>
          ) : (
            <Tag color="blue">{t("racepack.localNeedsId")}</Tag>
          )
        ) : null}
      </Space>
      {needsId ? (
        <Checkbox
          checked={idChecked}
          onChange={(e) => setIdChecked(e.target.checked)}
          style={{ marginTop: 12, minHeight: 32 }}
          data-testid={`${testId}-id-check`}
        >
          {t("racepack.idCheck")}
        </Checkbox>
      ) : null}
      {error ? <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
        <Button
          type="primary"
          size="large"
          shape="round"
          disabled={blocked}
          loading={issue.isPending && !proxyOpen}
          onClick={() => run({})}
          data-testid={`${testId}-self`}
        >
          {t("racepack.issueSelf")}
        </Button>
        <Button
          size="large"
          shape="round"
          disabled={!canIssue}
          onClick={() => setProxyOpen((v) => !v)}
          data-testid={`${testId}-proxy`}
        >
          {t("racepack.issueProxy")}
        </Button>
      </div>
      {proxyOpen ? (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <Typography.Text strong>{t("racepack.proxyTitle")}</Typography.Text>
          <Input
            style={{ marginTop: 8 }}
            size="large"
            value={proxyName}
            maxLength={80}
            onChange={(e) => setProxyName(e.target.value)}
            placeholder={t("racepack.proxyName")}
            aria-label={t("racepack.proxyName")}
            data-testid={`${testId}-proxy-name`}
          />
          <Checkbox
            checked={proxyChecked}
            onChange={(e) => setProxyChecked(e.target.checked)}
            style={{ marginTop: 10 }}
            data-testid={`${testId}-proxy-check`}
          >
            {t("racepack.proxyCheck")}
          </Checkbox>
          <Button
            block
            type="primary"
            size="large"
            shape="round"
            style={{ marginTop: 12 }}
            disabled={blocked || proxyName.trim() === "" || !proxyChecked}
            loading={issue.isPending}
            onClick={() => run({ proxyName: proxyName.trim() })}
            data-testid={`${testId}-proxy-confirm`}
          >
            {t("racepack.proxyConfirm")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
