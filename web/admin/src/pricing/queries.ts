import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export function priceRulesKey(eventId: number) {
  return ["admin", "price-rules", eventId] as const;
}

export function usePriceRules(eventId: number) {
  const api = useApi();
  return useQuery({
    queryKey: priceRulesKey(eventId),
    queryFn: async () =>
      unwrap(await api.GET("/admin/events/{id}/price-rules", { params: { path: { id: eventId } } })).items,
  });
}

/** id 为 undefined 时新建，否则修改 */
export function useSavePriceRule(eventId: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: number; body: Schemas["PriceRuleInput"] }) =>
      id === undefined
        ? unwrap(await api.POST("/admin/events/{id}/price-rules", { params: { path: { id: eventId } }, body }))
        : unwrap(await api.PUT("/admin/price-rules/{id}", { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: priceRulesKey(eventId) }),
  });
}
