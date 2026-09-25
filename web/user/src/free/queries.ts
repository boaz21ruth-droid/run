import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type ApiClient, type Schemas } from "@werun/api-client";
import { useLang, type Lang } from "@werun/i18n";
import { useApi } from "../api";
import { FREE_SIGNUPS_KEY } from "../orders/api";

async function fetchRegistrationConsent(api: ApiClient, lang: Lang) {
  return unwrap(await api.GET("/app/consents", { params: { query: { purpose: "REGISTRATION", lang } } }));
}

export type RegistrationConsent = Awaited<ReturnType<typeof fetchRegistrationConsent>>;

export function useRegistrationConsent() {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["consent", "REGISTRATION", lang],
    queryFn: () => fetchRegistrationConsent(api, lang),
  });
}

export function useCreateFreeSignup(slug: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["FreeSignupRequest"]) =>
      unwrap(await api.POST("/app/events/{slug}/free-signups", { params: { path: { slug } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FREE_SIGNUPS_KEY }),
  });
}
