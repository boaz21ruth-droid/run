import { useQuery } from "@tanstack/react-query";
import { unwrap, type ApiClient, type Schemas } from "@werun/api-client";
import type { Lang } from "@werun/i18n";
import { useApi } from "../api";

export function useRegistrationConsent(lang: Lang) {
  const api = useApi();
  return useQuery({
    queryKey: ["register", "consent", lang],
    queryFn: async () => unwrap(await api.GET("/app/consents", { params: { query: { purpose: "REGISTRATION", lang } } })),
  });
}

/** 所有算价预览缓存的前缀；售罄后清掉，回到确认页时重新算价 */
export const QUOTE_KEY = ["register", "quote"] as const;

export function quoteQueryKey(slug: string, body: Schemas["QuoteRequest"]) {
  return [...QUOTE_KEY, slug, JSON.stringify(body)] as const;
}

export async function fetchQuote(api: ApiClient, slug: string, body: Schemas["QuoteRequest"]): Promise<Schemas["Quote"]> {
  return unwrap(await api.POST("/app/events/{slug}/quote", { params: { path: { slug } }, body }));
}

export async function createOrder(api: ApiClient, idempotencyKey: string, body: Schemas["CreateOrderRequest"]): Promise<Schemas["OrderDetail"]> {
  return unwrap(await api.POST("/app/orders", { params: { header: { "Idempotency-Key": idempotencyKey } }, body }));
}
