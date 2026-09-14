import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export const ADMIN_EVENTS_KEY = ["admin", "events"] as const;

export function useAdminEvents() {
  const api = useApi();
  return useQuery({
    queryKey: ADMIN_EVENTS_KEY,
    queryFn: async () => unwrap(await api.GET("/admin/events")).items,
  });
}

export function useCreateEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["CreateEventRequest"]) => unwrap(await api.POST("/admin/events", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EVENTS_KEY }),
  });
}

export function usePublishEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) =>
      unwrap(await api.POST("/admin/events/{id}/publish", { params: { path: { id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EVENTS_KEY }),
  });
}
