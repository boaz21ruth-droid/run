import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useApi } from "../api";

export type FeedKind = "ALL" | "OFFICIAL" | "CLUB";

export const COMMUNITY_KEY = ["community"] as const;
const feedKey = (kind: FeedKind, city: string, lang: string) => [...COMMUNITY_KEY, "feed", kind, city, lang] as const;
const checkinKey = [...COMMUNITY_KEY, "checkin"] as const;
export const activityKey = (id: number) => [...COMMUNITY_KEY, "activity", id] as const;
export const MINE_KEY = [...COMMUNITY_KEY, "mine"] as const;

export function useCommunityFeed(kind: FeedKind, city: string) {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: feedKey(kind, city, lang),
    queryFn: async () =>
      unwrap(await api.GET("/community/feed", { params: { query: { kind, ...(city ? { city } : {}) } } })),
    placeholderData: (previous) => previous,
  });
}

export function useCheckin(enabled: boolean) {
  const api = useApi();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: checkinKey,
    queryFn: async () => unwrap(await api.GET("/app/community/checkin")),
    enabled,
  });
  const toggle = useMutation({
    mutationFn: async (checkIn: boolean) =>
      checkIn ? unwrap(await api.POST("/app/community/checkin", { body: {} })) : unwrap(await api.DELETE("/app/community/checkin")),
    onSuccess: (data) => {
      queryClient.setQueryData(checkinKey, data);
      void queryClient.invalidateQueries({ queryKey: [...COMMUNITY_KEY, "feed"] });
    },
  });
  return { state, toggle };
}

export function useActivityView(id: number) {
  const api = useApi();
  return useQuery({
    queryKey: activityKey(id),
    queryFn: async () => unwrap(await api.GET("/app/community/activities/{id}/me", { params: { path: { id } } })),
  });
}

export function useActivityAction(id: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: "join" | "leave" | "close"): Promise<Schemas["CommunityActivityView"]> => {
      const path = { params: { path: { id } } };
      if (action === "join") return unwrap(await api.POST("/app/community/activities/{id}/join", path));
      if (action === "leave") return unwrap(await api.POST("/app/community/activities/{id}/leave", path));
      return unwrap(await api.POST("/app/community/activities/{id}/close", path));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(activityKey(id), data);
      void queryClient.invalidateQueries({ queryKey: [...COMMUNITY_KEY, "feed"] });
      void queryClient.invalidateQueries({ queryKey: MINE_KEY });
    },
  });
}

export function useCommunityConsent() {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["consent", "COMMUNITY", lang],
    queryFn: async () => unwrap(await api.GET("/app/consents", { params: { query: { purpose: "COMMUNITY", lang } } })),
    placeholderData: (previous) => previous,
  });
}

export function useMyActivities() {
  const api = useApi();
  return useQuery({ queryKey: MINE_KEY, queryFn: async () => unwrap(await api.GET("/app/community/mine")).items });
}
