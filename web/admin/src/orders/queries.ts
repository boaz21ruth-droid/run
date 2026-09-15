import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export type AdminOrderStatus = Schemas["AdminOrderSummary"]["status"];

export const ORDER_STATUSES: readonly AdminOrderStatus[] = [
  "PENDING_PAYMENT",
  "PROOF_SUBMITTED",
  "PROOF_REJECTED",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "EXPIRED",
  "CANCELLED",
];

export const ORDER_PAGE_SIZE = 20;
export const ADMIN_ORDERS_KEY = ["admin", "orders"] as const;

export interface AdminOrderFilter {
  eventId?: number;
  status?: AdminOrderStatus;
  q?: string;
  page: number;
}

export function useAdminOrders(filter: AdminOrderFilter) {
  const api = useApi();
  return useQuery({
    queryKey: [...ADMIN_ORDERS_KEY, "list", filter],
    queryFn: async () =>
      unwrap(
        await api.GET("/admin/orders", {
          params: {
            query: {
              eventId: filter.eventId,
              status: filter.status,
              q: filter.q,
              limit: ORDER_PAGE_SIZE,
              offset: (filter.page - 1) * ORDER_PAGE_SIZE,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useAdminOrder(id: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...ADMIN_ORDERS_KEY, "detail", id],
    queryFn: async () => unwrap(await api.GET("/admin/orders/{id}", { params: { path: { id } } })),
    enabled: Number.isInteger(id) && id > 0,
  });
}

/** 订单筛选用的赛事下拉；没有 event_config 读权限时不请求 */
export function useEventOptions(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["admin", "events", "options"],
    queryFn: async () => unwrap(await api.GET("/admin/events")).items,
    enabled,
  });
}
