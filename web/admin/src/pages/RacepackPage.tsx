import { CameraOutlined, SearchOutlined } from "@ant-design/icons";
import { useLang } from "@werun/i18n";
import { Alert, Button, Card, Empty, Input, Modal, Progress, Select, Space, Spin, Typography, type InputRef } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { PERM_RACEPACK_ISSUE, PERM_RACEPACK_UNDO, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { formatInTimezone } from "../time/eventTime";
import { EntryCard } from "../racepack/EntryCard";
import { useRacepackEvents, useStation } from "../racepack/queries";
import { canScanQr, scanQr } from "../racepack/scanner";

/** 输入停顿多久后搜索；扫码枪按回车会立即搜索 */
export const SEARCH_DEBOUNCE_MS = 300;

/** 领物核销站（v8 第 8 屏）：手机即可用，现场志愿者 / 现场主管 / 运营共用 */
export function RacepackPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const { data: me } = useMe();
  const events = useRacepackEvents();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const list = events.data ?? [];
  const fromUrl = Number(params.get("event"));
  const eventId = list.some((e) => e.id === fromUrl) ? fromUrl : list.length === 1 ? list[0]!.id : null;
  const station = useStation(eventId, query);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (!scanning || !videoRef.current) return;
    const controller = new AbortController();
    scanQr(videoRef.current, controller.signal)
      .then((code) => {
        if (code) {
          setText(code);
          setQuery(code);
        }
      })
      .catch(() => undefined)
      .finally(() => setScanning(false));
    return () => controller.abort();
  }, [scanning]);

  const canIssue = can(me?.permissions, PERM_RACEPACK_ISSUE, "write");
  const canUndo = can(me?.permissions, PERM_RACEPACK_UNDO, "write");
  const resetSearch = () => {
    setText("");
    setQuery("");
    inputRef.current?.focus();
  };

  if (events.isLoading) {
    return <Spin />;
  }
  if (events.error) {
    return <Alert type="error" showIcon message={events.error.message} />;
  }
  if (list.length === 0) {
    return <Empty data-testid="racepack-no-events" description={t("racepack.noEvents")} />;
  }

  const data = station.data;
  const tz = data?.event.timezone ?? "Asia/Phnom_Penh";
  const percent = data && data.confirmed > 0 ? Math.round((data.picked / data.confirmed) * 100) : 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%", maxWidth: 560 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          borderRadius: "var(--r)",
          background: "var(--night-deep)",
          color: "#fff",
        }}
      >
        <Typography.Title level={4} style={{ margin: 0, color: "#fff" }}>
          {t("racepack.title")}
        </Typography.Title>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--sky-2)" }}>{me?.staff.fullName}</span>
      </div>

      {list.length > 1 || eventId == null ? (
        <Select
          size="large"
          style={{ width: "100%" }}
          placeholder={t("racepack.chooseEvent")}
          value={eventId ?? undefined}
          onChange={(id: number) => setParams({ event: String(id) })}
          options={list.map((e) => ({ value: e.id, label: `${pickText(e.name, lang)} · ${e.raceDate}` }))}
          data-testid="racepack-event"
        />
      ) : null}

      {eventId != null && data ? (
        <>
          <div>
            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Typography.Text type="secondary">{pickText(data.event.name, lang)}</Typography.Text>
              <Typography.Text strong data-testid="racepack-progress">
                {t("racepack.progress", { picked: data.picked, confirmed: data.confirmed })}
              </Typography.Text>
            </Space>
            <Progress percent={percent} showInfo={false} strokeColor="var(--leaf)" />
          </div>

          <Input
            ref={inputRef}
            size="large"
            autoFocus
            allowClear
            prefix={<SearchOutlined />}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPressEnter={() => setQuery(text.trim())}
            placeholder={t("racepack.searchPlaceholder")}
            aria-label={t("racepack.searchPlaceholder")}
            inputMode="search"
            autoComplete="off"
            data-testid="racepack-search"
          />
          {canScanQr() ? (
            <Button shape="round" icon={<CameraOutlined />} onClick={() => setScanning(true)} data-testid="racepack-scan">
              {t("racepack.scan")}
            </Button>
          ) : null}

          {query !== "" ? (
            station.isFetching && data.results.length === 0 ? (
              <Spin />
            ) : data.results.length === 0 ? (
              <Empty data-testid="racepack-no-results" description={t("racepack.noResults", { q: query })} />
            ) : (
              <Space direction="vertical" style={{ width: "100%" }}>
                {data.results.map((entry) => (
                  <EntryCard
                    key={entry.registrationId}
                    entry={entry}
                    timezone={tz}
                    canIssue={canIssue}
                    canUndo={canUndo}
                    onIssued={resetSearch}
                  />
                ))}
              </Space>
            )
          ) : (
            <Typography.Text type="secondary">{t("racepack.searchHint")}</Typography.Text>
          )}

          {data.recent.length > 0 ? (
            <Card size="small" title={t("racepack.recent")}>
              <Space direction="vertical" size={4} style={{ width: "100%" }} data-testid="racepack-recent">
                {data.recent.map((r) => (
                  <div key={`${r.registrationId}-${r.occurredAt}`} style={{ fontSize: 13 }}>
                    <Typography.Text strong>{[r.bib, r.fullName].filter(Boolean).join(" · ")}</Typography.Text>{" "}
                    <Typography.Text type="secondary">
                      {formatInTimezone(r.occurredAt, tz)} · {r.staffName}
                      {r.proxyName ? ` · ${t("racepack.byProxy", { name: r.proxyName })}` : ""}
                    </Typography.Text>
                  </div>
                ))}
              </Space>
            </Card>
          ) : null}
        </>
      ) : eventId != null ? (
        station.error ? (
          <Alert type="error" showIcon message={station.error.message} />
        ) : (
          <Spin />
        )
      ) : null}

      <Modal open={scanning} footer={null} onCancel={() => setScanning(false)} title={t("racepack.scan")} forceRender>
        <video ref={videoRef} playsInline muted style={{ width: "100%", borderRadius: 12, background: "#000" }} />
      </Modal>
    </Space>
  );
}
