import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export const ORDERS_KEY = ["orders"] as const;

export function orderKey(orderNo: string) {
  return [...ORDERS_KEY, orderNo] as const;
}

export function useMyOrders() {
  const api = useApi();
  return useQuery({
    queryKey: ORDERS_KEY,
    queryFn: async () => unwrap(await api.GET("/app/orders")).items,
  });
}

/** 凭证审核中的订单每 15 秒刷新一次，财务一审完页面就跟着变；其他状态不轮询 */
export const REVIEW_POLL_MS = 15_000;

export function orderRefetchInterval(status: Schemas["OrderDetail"]["status"] | undefined): number | false {
  return status === "PROOF_SUBMITTED" ? REVIEW_POLL_MS : false;
}

export function useMyOrder(orderNo: string) {
  const api = useApi();
  return useQuery({
    queryKey: orderKey(orderNo),
    queryFn: async () => unwrap(await api.GET("/app/orders/{orderNo}", { params: { path: { orderNo } } })),
    refetchInterval: (query) => orderRefetchInterval(query.state.data?.status),
  });
}

export function useCancelOrder(orderNo: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => unwrap(await api.POST("/app/orders/{orderNo}/cancel", { params: { path: { orderNo } } })),
    onSuccess: (order) => {
      queryClient.setQueryData(orderKey(orderNo), order);
      void queryClient.invalidateQueries({ queryKey: ORDERS_KEY, exact: true });
    },
  });
}

export const FREE_SIGNUPS_KEY = ["free-signups"] as const;

export function useMyFreeSignups() {
  const api = useApi();
  return useQuery({
    queryKey: FREE_SIGNUPS_KEY,
    queryFn: async () => unwrap(await api.GET("/app/free-signups")).items,
  });
}
