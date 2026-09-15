import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useApi } from "./api";

export function usePublicEvents() {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["events", lang],
    queryFn: async () => unwrap(await api.GET("/events")).items,
  });
}

export function usePublicEvent(slug: string) {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["event", slug, lang],
    queryFn: async () => unwrap(await api.GET("/events/{slug}", { params: { path: { slug } } })),
  });
}

/** 常用参赛人接口不按语言返回文案，查询 key 不带语言 */
export const PROFILES_KEY = ["profiles"] as const;

export function useProfiles() {
  const api = useApi();
  return useQuery({
    queryKey: PROFILES_KEY,
    queryFn: async () => unwrap(await api.GET("/app/profiles")).items,
  });
}

export function useCreateProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["ProfileInput"]) => unwrap(await api.POST("/app/profiles", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useUpdateProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Schemas["ProfileInput"] }) =>
      unwrap(await api.PUT("/app/profiles/{id}", { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useDeleteProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      unwrap(await api.DELETE("/app/profiles/{id}", { params: { path: { id } } }));
    },
    // 404（已被删除）时同样刷新列表
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}
