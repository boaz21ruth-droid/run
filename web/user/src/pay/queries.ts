import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";
import { ORDERS_KEY } from "../orders/api";
import { toProofFormData, type ProofSubmission } from "./proofForm";

type SubmitProofBody = Schemas["SubmitProofForm"];

/**
 * multipart 接口：body 的类型只用于类型检查（openapi-typescript 把 format: binary 生成为 string），
 * 真正发出的请求体是 bodySerializer 返回的 FormData；openapi-fetch 遇到 FormData 时不设置 Content-Type，
 * 由浏览器自动带上 boundary。
 */
export function useSubmitProof(orderNo: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (submission: ProofSubmission) => {
      const form = toProofFormData(submission);
      return unwrap(
        await api.POST("/app/orders/{orderNo}/proofs", {
          params: { path: { orderNo } },
          body: form as unknown as SubmitProofBody,
          bodySerializer: () => form,
        }),
      );
    },
    // 订单列表与订单详情共用 ["orders"] 前缀的查询键，一起失效
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORDERS_KEY }),
  });
}
