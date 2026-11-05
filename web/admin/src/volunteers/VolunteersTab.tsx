import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  type FormInstance,
  type TableProps,
} from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { PERM_EVENT_CONFIG, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { toNamePath } from "../events/eventForm";
import { pickText } from "../events/localize";
import { formatInTimezone } from "../time/eventTime";

type AdminEvent = Schemas["AdminEvent"];
type Board = Schemas["VolunteerBoard"];
type Role = Schemas["AdminVolunteerRole"];
type Application = Schemas["AdminVolunteerApplication"];
type LocalizedText = Schemas["LocalizedText"];

const LANGS = ["zh", "en", "km"] as const;
const boardKey = (eventId: number) => ["admin", "volunteers", eventId] as const;

/** 可选的志愿者日期：比赛日与赛前 13 天（简报、领物通常在比赛周） */
export function volunteerDateOptions(raceDate: string): string[] {
  const race = dayjs(raceDate);
  return Array.from({ length: 14 }, (_, i) => race.subtract(13 - i, "day").format("YYYY-MM-DD"));
}

/** 赛事详情的「志愿者」页：招募设置、岗位与席位、申请分配（v8 设计稿 09） */
export function VolunteersTab({ event }: { event: AdminEvent }) {
  const api = useApi();
  const { data: me } = useMe();
  const canWrite = can(me?.permissions, PERM_EVENT_CONFIG, "write");
  const board = useQuery({
    queryKey: boardKey(event.id),
    queryFn: async () => unwrap(await api.GET("/admin/events/{id}/volunteers", { params: { path: { id: event.id } } })),
  });
  if (board.isError) {
    return <Alert type="error" showIcon message={board.error.message} />;
  }
  if (!board.data) {
    return <Card loading />;
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <SettingsCard event={event} board={board.data} canWrite={canWrite} />
      <RolesCard event={event} board={board.data} canWrite={canWrite} />
      <ApplicationsCard event={event} board={board.data} canWrite={canWrite} />
    </Space>
  );
}

function useBoardSaved(eventId: number) {
  const queryClient = useQueryClient();
  return (data: Board) => queryClient.setQueryData(boardKey(eventId), data);
}

/** 把接口的字段错误挂到表单项上；没有字段错误时返回 false，由调用方提示整体错误 */
function applyFieldErrors<T>(form: FormInstance<T>, error: unknown): boolean {
  if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
    form.setFields(
      Object.entries(error.fields).map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
        FormInstance<T>["setFields"]
      >[0],
    );
    return true;
  }
  return false;
}

interface SettingsValues {
  open: boolean;
  dates: string[];
  note: Record<(typeof LANGS)[number], string>;
}

function SettingsCard({ event, board, canWrite }: { event: AdminEvent; board: Board; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const { message } = AntdApp.useApp();
  const onSaved = useBoardSaved(event.id);
  const [form] = Form.useForm<SettingsValues>();
  const s = board.settings;
  const save = useMutation({
    mutationFn: async (body: Schemas["VolunteerSettings"]) =>
      unwrap(await api.PUT("/admin/events/{id}/volunteer-settings", { params: { path: { id: event.id } }, body })),
    onSuccess: (data) => {
      onSaved(data);
      void message.success(t("volunteers.settings.saved"));
    },
    onError: (error) => {
      if (!applyFieldErrors(form, error)) {
        void message.error(error.message);
      }
    },
  });
  const dateOptions = volunteerDateOptions(event.raceDate).map((d) => ({
    value: d,
    label: d === event.raceDate ? t("volunteers.settings.raceDay", { date: dayjs(d).format("M/D") }) : dayjs(d).format("M/D ddd"),
  }));
  const onFinish = (v: SettingsValues) => {
    const note = { zh: v.note.zh.trim(), en: v.note.en.trim(), km: v.note.km.trim() };
    save.mutate({ open: v.open, dates: [...v.dates].sort(), note: note.zh || note.en || note.km ? note : null });
  };
  return (
    <Card title={t("volunteers.settings.title")}>
      <Form<SettingsValues>
        form={form}
        name="volunteerSettings"
        layout="vertical"
        disabled={!canWrite || save.isPending}
        onFinish={onFinish}
        initialValues={{
          open: s.open,
          dates: s.dates,
          note: { zh: s.note?.zh ?? "", en: s.note?.en ?? "", km: s.note?.km ?? "" },
        }}
      >
        <Form.Item name="open" label={t("volunteers.settings.open")} valuePropName="checked">
          <Switch data-testid="volunteer-open" />
        </Form.Item>
        <Form.Item name="dates" label={t("volunteers.settings.dates")} extra={t("volunteers.settings.datesHelp")}>
          <Select mode="multiple" options={dateOptions} data-testid="volunteer-dates" />
        </Form.Item>
        <Row gutter={16}>
          {LANGS.map((l) => (
            <Col key={l} xs={24} md={8}>
              <Form.Item name={["note", l]} label={t(`volunteers.settings.note.${l}`)}>
                <Input maxLength={120} placeholder={t("volunteers.settings.notePlaceholder")} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        {canWrite ? (
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="volunteer-settings-save">
            {t("volunteers.save")}
          </Button>
        ) : null}
      </Form>
    </Card>
  );
}

function RolesCard({ event, board, canWrite }: { event: AdminEvent; board: Board; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const columns: TableProps<Role>["columns"] = [
    {
      title: t("volunteers.roles.col.name"),
      key: "name",
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{pickText(r.name, lang)}</Typography.Text>
            {r.active ? null : <Tag>{t("volunteers.roles.inactive")}</Tag>}
          </Space>
          {r.schedule ? <Typography.Text type="secondary">{pickText(r.schedule, lang)}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: t("volunteers.roles.col.seats"),
      key: "seats",
      render: (_, r) => (
        <span data-testid={`volunteer-role-seats-${r.id}`}>
          {r.assignedCount} / {r.capacity}
          {r.assignedCount >= r.capacity ? (
            <Tag color="red" style={{ marginLeft: 8 }}>
              {t("volunteers.roles.full")}
            </Tag>
          ) : null}
        </span>
      ),
    },
    { title: t("volunteers.roles.col.candidates"), dataIndex: "candidates", key: "candidates" },
    {
      title: t("volunteers.roles.col.actions"),
      key: "actions",
      render: (_, r) =>
        canWrite ? (
          <Button size="small" onClick={() => setEditing(r)} data-testid={`volunteer-role-edit-${r.id}`}>
            {t("volunteers.roles.edit")}
          </Button>
        ) : null,
    },
  ];
  return (
    <Card
      title={t("volunteers.roles.title")}
      extra={
        canWrite ? (
          <Button type="primary" onClick={() => setEditing("new")} data-testid="volunteer-role-create">
            {t("volunteers.roles.create")}
          </Button>
        ) : null
      }
    >
      <Table<Role>
        rowKey="id"
        columns={columns}
        dataSource={board.roles}
        pagination={false}
        scroll={{ x: 560 }}
        locale={{ emptyText: t("volunteers.roles.empty") }}
      />
      {editing ? <RoleModal event={event} role={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

interface RoleValues {
  name: Record<(typeof LANGS)[number], string>;
  schedule: Record<(typeof LANGS)[number], string>;
  capacity: number | null;
  sortOrder: number | null;
  active: boolean;
}

function textOf(v: Record<(typeof LANGS)[number], string>): LocalizedText {
  return { zh: v.zh.trim(), en: v.en.trim(), km: v.km.trim() };
}

function RoleModal({ event, role, onClose }: { event: AdminEvent; role: Role | null; onClose: () => void }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const { message } = AntdApp.useApp();
  const onSaved = useBoardSaved(event.id);
  const [form] = Form.useForm<RoleValues>();
  const save = useMutation({
    mutationFn: async (v: RoleValues) => {
      const base = { name: textOf(v.name), schedule: textOf(v.schedule), capacity: v.capacity ?? 0, sortOrder: v.sortOrder ?? 0 };
      return role
        ? unwrap(await api.PUT("/admin/volunteer-roles/{id}", { params: { path: { id: role.id } }, body: { ...base, active: v.active } }))
        : unwrap(await api.POST("/admin/events/{id}/volunteer-roles", { params: { path: { id: event.id } }, body: base }));
    },
    onSuccess: (data) => {
      onSaved(data);
      void message.success(t("volunteers.roles.saved"));
      onClose();
    },
    onError: (error) => {
      if (!applyFieldErrors(form, error)) {
        void message.error(error.message);
      }
    },
  });
  const required = [{ required: true, whitespace: true, message: t("volunteers.required") }];
  return (
    <Modal
      open
      title={role ? t("volunteers.roles.editTitle") : t("volunteers.roles.createTitle")}
      onCancel={onClose}
      footer={null}
      width={640}
      maskClosable={false}
    >
      <Form<RoleValues>
        form={form}
        name="volunteerRole"
        layout="vertical"
        disabled={save.isPending}
        onFinish={(v) => save.mutate(v)}
        initialValues={{
          name: { zh: role?.name.zh ?? "", en: role?.name.en ?? "", km: role?.name.km ?? "" },
          schedule: { zh: role?.schedule?.zh ?? "", en: role?.schedule?.en ?? "", km: role?.schedule?.km ?? "" },
          capacity: role?.capacity ?? 5,
          sortOrder: role?.sortOrder ?? 0,
          active: role?.active ?? true,
        }}
      >
        <Row gutter={16}>
          {LANGS.map((l) => (
            <Col key={l} xs={24} md={8}>
              <Form.Item name={["name", l]} label={t(`volunteers.roles.name.${l}`)} rules={required}>
                <Input maxLength={120} />
              </Form.Item>
            </Col>
          ))}
          {LANGS.map((l) => (
            <Col key={l} xs={24} md={8}>
              <Form.Item name={["schedule", l]} label={t(`volunteers.roles.schedule.${l}`)}>
                <Input maxLength={120} placeholder={t("volunteers.roles.schedulePlaceholder")} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        <Row gutter={16}>
          <Col xs={12} md={8}>
            <Form.Item
              name="capacity"
              label={t("volunteers.roles.capacity")}
              extra={role ? t("volunteers.roles.capacityHelp", { n: role.assignedCount }) : undefined}
              rules={[{ required: true, message: t("volunteers.required") }]}
            >
              <InputNumber min={role?.assignedCount ?? 0} max={10000} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="sortOrder" label={t("volunteers.roles.sortOrder")}>
              <InputNumber precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          {role ? (
            <Col xs={24} md={8}>
              <Form.Item name="active" label={t("volunteers.roles.active")} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          ) : null}
        </Row>
        <Space style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button onClick={onClose}>{t("volunteers.cancel")}</Button>
          <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="volunteer-role-submit">
            {t("volunteers.save")}
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}

function ApplicationsCard({ event, board, canWrite }: { event: AdminEvent; board: Board; canWrite: boolean }) {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const api = useApi();
  const { message } = AntdApp.useApp();
  const onSaved = useBoardSaved(event.id);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [rejecting, setRejecting] = useState<Application | null>(null);
  const [note, setNote] = useState("");
  const roleName = (id: number) => {
    const r = board.roles.find((x) => x.id === id);
    return r ? pickText(r.name, lang) : `#${id}`;
  };
  const act = useMutation({
    mutationFn: async (vars: { id: number; action: "assign" | "waitlist" | "reject"; roleId?: number; note?: string }) => {
      const path = { params: { path: { id: vars.id } } };
      if (vars.action === "assign") {
        return unwrap(await api.POST("/admin/volunteer-applications/{id}/assign", { ...path, body: { roleId: vars.roleId ?? 0 } }));
      }
      if (vars.action === "waitlist") {
        return unwrap(await api.POST("/admin/volunteer-applications/{id}/waitlist", path));
      }
      return unwrap(await api.POST("/admin/volunteer-applications/{id}/reject", { ...path, body: vars.note ? { note: vars.note } : {} }));
    },
    onSuccess: (data, vars) => {
      onSaved(data);
      void message.success(t(`volunteers.apps.done.${vars.action}`));
      setRejecting(null);
      setNote("");
    },
    onError: (error) => void message.error(error.message),
  });
  const counts = board.applications.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.status]: (acc[a.status] ?? 0) + 1 }), {});

  const columns: TableProps<Application>["columns"] = [
    {
      title: t("volunteers.apps.col.applicant"),
      key: "applicant",
      render: (_, a) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{a.fullName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {a.phone}
          </Typography.Text>
          {a.telegramUsername ? (
            <Typography.Link href={`https://t.me/${a.telegramUsername}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              @{a.telegramUsername}
            </Typography.Link>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("volunteers.apps.col.availability"),
      key: "availability",
      render: (_, a) => (a.fullAvailability ? t("volunteers.apps.allDays") : a.dates.map((d) => dayjs(d).format("M/D")).join(" · ")),
    },
    {
      title: t("volunteers.apps.col.choices"),
      key: "choices",
      render: (_, a) => (
        <Space direction="vertical" size={2}>
          <Space size={4} wrap>
            {a.roleIds.map((id) => (
              <Tag key={id}>{roleName(id)}</Tag>
            ))}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[a.tshirtSize ? t("volunteers.apps.tshirt", { size: a.tshirtSize }) : null, a.mediaConsent ? t("volunteers.apps.media") : null]
              .filter(Boolean)
              .join(" · ")}
          </Typography.Text>
          {a.note ? (
            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, expandable: true }} style={{ margin: 0, maxWidth: 260 }}>
              {a.note}
            </Typography.Paragraph>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("volunteers.apps.col.submitted"),
      key: "createdAt",
      render: (_, a) => formatInTimezone(a.createdAt, event.timezone),
    },
    {
      title: t("volunteers.apps.col.status"),
      key: "status",
      render: (_, a) => (
        <Space direction="vertical" size={2}>
          <Tag color={{ ASSIGNED: "green", PENDING: "orange", WAITLIST: "gold" }[a.status as string] ?? "default"}>
            {t(`volunteers.status.${a.status}`)}
          </Tag>
          {a.assignedRoleId ? <Typography.Text>{roleName(a.assignedRoleId)}</Typography.Text> : null}
          {a.reviewNote ? <Typography.Text type="secondary">{a.reviewNote}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: t("volunteers.apps.col.actions"),
      key: "actions",
      render: (_, a) => {
        if (!canWrite || a.status === "REJECTED" || a.status === "WITHDRAWN") {
          return null;
        }
        // 默认选申请人选的第一个还有席位的岗位
        const preferred = a.roleIds.find((id) => {
          const r = board.roles.find((x) => x.id === id);
          return r && r.active && r.assignedCount < r.capacity && id !== a.assignedRoleId;
        });
        const value = picked[a.id] ?? preferred;
        const options = board.roles
          .filter((r) => r.active && r.id !== a.assignedRoleId)
          .map((r) => ({
            value: r.id,
            label: `${a.roleIds.includes(r.id) ? "★ " : ""}${pickText(r.name, lang)} (${r.capacity - r.assignedCount})`,
            disabled: r.assignedCount >= r.capacity,
          }));
        return (
          <Space direction="vertical" size={6}>
            <Space.Compact>
              <Select
                size="small"
                style={{ width: 170 }}
                value={value}
                options={options}
                placeholder={t("volunteers.apps.pickRole")}
                onChange={(v: number) => setPicked((prev) => ({ ...prev, [a.id]: v }))}
                data-testid={`volunteer-assign-role-${a.id}`}
              />
              <Button
                size="small"
                type="primary"
                disabled={value === undefined}
                loading={act.isPending && act.variables?.id === a.id && act.variables.action === "assign"}
                onClick={() => value !== undefined && act.mutate({ id: a.id, action: "assign", roleId: value })}
                data-testid={`volunteer-assign-${a.id}`}
              >
                {a.status === "ASSIGNED" ? t("volunteers.apps.move") : t("volunteers.apps.assign")}
              </Button>
            </Space.Compact>
            <Space size={4}>
              {a.status !== "WAITLIST" ? (
                <Button size="small" onClick={() => act.mutate({ id: a.id, action: "waitlist" })} data-testid={`volunteer-waitlist-${a.id}`}>
                  {t("volunteers.apps.waitlist")}
                </Button>
              ) : null}
              <Button size="small" danger onClick={() => setRejecting(a)} data-testid={`volunteer-reject-${a.id}`}>
                {t("volunteers.apps.reject")}
              </Button>
            </Space>
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      title={t("volunteers.apps.title")}
      extra={
        <Typography.Text type="secondary" data-testid="volunteer-summary">
          {t("volunteers.apps.summary", {
            pending: counts.PENDING ?? 0,
            assigned: counts.ASSIGNED ?? 0,
            waitlist: counts.WAITLIST ?? 0,
          })}
        </Typography.Text>
      }
    >
      <Table<Application>
        rowKey="id"
        columns={columns}
        dataSource={board.applications}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 1000 }}
        locale={{ emptyText: t("volunteers.apps.empty") }}
      />
      {rejecting ? (
        <Modal
          open
          title={t("volunteers.apps.rejectTitle", { name: rejecting.fullName })}
          onCancel={() => setRejecting(null)}
          onOk={() => act.mutate({ id: rejecting.id, action: "reject", note: note.trim() })}
          okText={t("volunteers.apps.rejectConfirm")}
          okButtonProps={{ danger: true, loading: act.isPending, "data-testid": "volunteer-reject-confirm" }}
          cancelText={t("volunteers.cancel")}
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("volunteers.apps.notePlaceholder")}
            data-testid="volunteer-reject-note"
          />
        </Modal>
      ) : null}
    </Card>
  );
}
