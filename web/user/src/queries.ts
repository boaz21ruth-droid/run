import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@werun/api-client";
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
