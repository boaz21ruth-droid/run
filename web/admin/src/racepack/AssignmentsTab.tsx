import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { Alert, App as AntdApp, Button, DatePicker, Select, Space, Switch, Table, Tag, Typography, type TableProps } from "antd";
import type { Dayjs } from "dayjs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { formatInTimezone, fromEventWallClock, toEventWallClock } from "../time/eventTime";
import { TimezoneHint } from "../time/TimezoneHint";

type AdminEvent = Schemas["AdminEvent"];
type Assignment = Schemas["EventAssignment"];

/** 只有这三个现场角色按指派限制赛事范围（与后端 racepack.scopedRoles 一致） */
export const FIELD_ROLES = ["RACE_SUPERVISOR", "RACE_STAFF", "PHOTOGRAPHER"];

const KEY = ["admin", "assignments"] as const;

/** 赛事详情的「现场人员」页：管理员指派现场角色，限定有效期；领物核销站据此放行 */
export function AssignmentsTab({ event }: { event: AdminEvent }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();
  const tz = event.timezone;

  const assignments = useQuery({
    queryKey: [...KEY, event.id],
    queryFn: async () =>
      unwrap(await api.GET("/admin/events/{id}/staff-assignments", { params: { path: { id: event.id } } })).items,
  });
  const staff = useQuery({
    queryKey: ["admin", "staff"],
    queryFn: async () => unwrap(await api.GET("/admin/staff")).items,
  });
  const save = useMutation({
    mutationFn: async (vars: { staffId: number; body: Schemas["EventAssignmentRequest"] }) =>
      unwrap(
        await api.PUT("/admin/events/{id}/staff-assignments/{staffId}", {
          params: { path: { id: event.id, staffId: vars.staffId } },
          body: vars.body,
        }),
      ).items,
    onSuccess: (items) => {
      queryClient.setQueryData([...KEY, event.id], items);
      void message.success(t("assignments.saved"));
    },
  });

  // 默认窗口：从现在起到比赛后一天 0 点（赛事时区），覆盖领物日与比赛日；指派了就能马上试用核销站
  const raceDay = toEventWallClock(`${event.raceDate}T00:00:00Z`, "UTC");
  const [staffId, setStaffId] = useState<number | null>(null);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [
    toEventWallClock(new Date().toISOString(), tz).startOf("minute"),
    raceDay.add(1, "day"),
  ]);

  const candidates = (staff.data ?? []).filter(
    (m) => FIELD_ROLES.includes(m.role) && m.status === "ACTIVE",
  );

  const columns: TableProps<Assignment>["columns"] = [
    { title: t("assignments.col.staff"), key: "staff", render: (_, a) => `${a.fullName} (${a.username})` },
    { title: t("assignments.col.role"), key: "role", render: (_, a) => <Tag>{t(`role.${a.role}`)}</Tag> },
    {
      title: t("assignments.col.window"),
      key: "window",
      render: (_, a) => `${formatInTimezone(a.validFrom, tz)} – ${formatInTimezone(a.validUntil, tz)}`,
    },
    {
      title: t("assignments.col.enabled"),
      key: "enabled",
      render: (_, a) => (
        <Switch
          checked={a.enabled}
          loading={save.isPending && save.variables?.staffId === a.staffId}
          onChange={(enabled) =>
            save.mutate({ staffId: a.staffId, body: { validFrom: a.validFrom, validUntil: a.validUntil, enabled } })
          }
          data-testid={`assignment-enabled-${a.staffId}`}
        />
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        {t("assignments.intro")}
      </Typography.Paragraph>
      <Space wrap>
        <Select
          id="assignment_staff"
          style={{ minWidth: 240 }}
          placeholder={t("assignments.chooseStaff")}
          value={staffId ?? undefined}
          onChange={setStaffId}
          loading={staff.isLoading}
          options={candidates.map((m) => ({ value: m.id, label: `${m.fullName} · ${t(`role.${m.role}`)}` }))}
          data-testid="assignment-staff"
        />
        <DatePicker.RangePicker
          showTime={{ format: "HH:mm" }}
          format="YYYY-MM-DD HH:mm"
          value={range}
          allowClear={false}
          onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
        />
        <Button
          type="primary"
          disabled={staffId == null}
          loading={save.isPending && save.variables?.staffId === staffId}
          onClick={() =>
            staffId != null &&
            save.mutate({
              staffId,
              body: { validFrom: fromEventWallClock(range[0], tz), validUntil: fromEventWallClock(range[1], tz), enabled: true },
            })
          }
          data-testid="assignment-add"
        >
          {t("assignments.add")}
        </Button>
      </Space>
      <TimezoneHint tz={tz} />
      {save.error ? <Alert type="error" showIcon message={save.error.message} /> : null}
      <Table
        rowKey="staffId"
        size="small"
        loading={assignments.isLoading}
        columns={columns}
        dataSource={assignments.data ?? []}
        pagination={false}
        scroll={{ x: true }}
      />
    </Space>
  );
}
