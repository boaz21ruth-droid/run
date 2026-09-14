import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type paths } from "@werun/api-client";
import { useApi } from "../api";

type CreateBody = paths["/admin/payment-accounts"]["post"]["requestBody"]["content"]["multipart/form-data"];
type UpdateBody = paths["/admin/payment-accounts/{id}"]["put"]["requestBody"]["content"]["multipart/form-data"];

export const PAYMENT_ACCOUNTS_KEY = ["admin", "payment-accounts"] as const;

export function usePaymentAccounts() {
  const api = useApi();
  return useQuery({
    queryKey: PAYMENT_ACCOUNTS_KEY,
    queryFn: async () => unwrap(await api.GET("/admin/payment-accounts")).items,
  });
}

/**
 * multipart 接口：openapi-fetch 的 body 类型是 schema 描述的对象，这里实际发送 FormData，
 * 通过 bodySerializer 原样交给 fetch；body 是 FormData 时 openapi-fetch 不设置 Content-Type，由浏览器带上 boundary。
 */
export function useSavePaymentAccount() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, form }: { id?: number; form: FormData }) =>
      id === undefined
        ? unwrap(
            await api.POST("/admin/payment-accounts", {
              body: form as unknown as CreateBody,
              bodySerializer: () => form,
            }),
          )
        : unwrap(
            await api.PUT("/admin/payment-accounts/{id}", {
              params: { path: { id } },
              body: form as unknown as UpdateBody,
              bodySerializer: () => form,
            }),
          ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PAYMENT_ACCOUNTS_KEY }),
  });
}
