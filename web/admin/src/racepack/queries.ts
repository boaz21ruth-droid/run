import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";
import { deviceId } from "./device";

export const RACEPACK_KEY = ["admin", "racepack"] as const;

/** 多个柜台同时发放：进度与最近发放定时刷新 */
export const STATION_REFETCH_MS = 15_000;

export function useRacepackEvents() {
  const api = useApi();
  return useQuery({
    queryKey: [...RACEPACK_KEY, "events"],
    queryFn: async () => unwrap(await api.GET("/admin/racepack/events")).items,
  });
}

export function useStation(eventId: number | null, q: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...RACEPACK_KEY, "station", eventId, q],
    queryFn: async () =>
      unwrap(
        await api.GET("/admin/racepack/events/{id}", {
          params: { path: { id: eventId! }, query: q ? { q } : {} },
        }),
      ),
    enabled: eventId != null,
    placeholderData: keepPreviousData,
    refetchInterval: STATION_REFETCH_MS,
  });
}

export interface IssueVars {
  registrationId: number;
  proxyName?: string;
  idVerified?: boolean;
}

export function useIssueRacepack() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    // clientEventId 在每次点击时生成；react-query 的自动重试会沿用同一个变量对象，所以重试幂等
    mutationFn: async (vars: IssueVars & { clientEventId: string }) =>
      unwrap(
        await api.POST("/admin/racepack/registrations/{id}/issue", {
          params: { path: { id: vars.registrationId } },
          body: {
            clientEventId: vars.clientEventId,
            deviceId: deviceId(),
            ...(vars.proxyName ? { proxyName: vars.proxyName } : {}),
            ...(vars.idVerified ? { idVerified: true } : {}),
          },
        }),
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [...RACEPACK_KEY, "station"] }),
  });
}

export function useUndoRacepack() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { registrationId: number; reason: string; clientEventId: string }) =>
      unwrap(
        await api.POST("/admin/racepack/registrations/{id}/undo", {
          params: { path: { id: vars.registrationId } },
          body: { clientEventId: vars.clientEventId, deviceId: deviceId(), reason: vars.reason },
        }),
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [...RACEPACK_KEY, "station"] }),
  });
}

export type RacepackEntry = Schemas["RacepackEntry"];
export type RacepackStation = Schemas["RacepackStation"];
