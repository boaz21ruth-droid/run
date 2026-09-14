import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export function couponsKey(eventId: number) {
  return ["admin", "coupons", eventId] as const;
}

export function useCoupons(eventId: number) {
  const api = useApi();
  return useQuery({
    queryKey: couponsKey(eventId),
    queryFn: async () => unwrap(await api.GET("/admin/coupons", { params: { query: { eventId } } })).items,
  });
}

export type SaveCouponInput =
  | { id: undefined; body: Schemas["CreateCouponRequest"] }
  | { id: number; body: Schemas["UpdateCouponRequest"] };

export function useSaveCoupon(eventId: number) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveCouponInput) =>
      input.id === undefined
        ? unwrap(await api.POST("/admin/coupons", { body: input.body }))
        : unwrap(await api.PUT("/admin/coupons/{id}", { params: { path: { id: input.id } }, body: input.body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: couponsKey(eventId) }),
  });
}
