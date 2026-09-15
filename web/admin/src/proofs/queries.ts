import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";
import { ADMIN_ORDERS_KEY } from "../orders/queries";

export const PROOFS_KEY = ["admin", "proofs"] as const;

export function adminFileUrl(fileId: number): string {
  return `/api/admin/files/${fileId}`;
}

/**
 * 待审队列。adminListProofs 每种状态都固定按提交时间升序、最多 500 行、不分页，
 * 历史（已通过 / 已驳回）在这里再筛选会挡住更晚提交的行，所以这个页面只请求 SUBMITTED；
 * 已审核历史在订单详情页的凭证记录里看（见 OrderProofsCard）。
 */
export function useProofQueue() {
  const api = useApi();
  return useQuery({
    queryKey: [...PROOFS_KEY, "queue", "SUBMITTED"],
    queryFn: async () => unwrap(await api.GET("/admin/proofs", { params: { query: { status: "SUBMITTED" } } })).items,
  });
}

export function useProof(id: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...PROOFS_KEY, "detail", id],
    queryFn: async () => unwrap(await api.GET("/admin/proofs/{id}", { params: { path: { id } } })),
    enabled: Number.isInteger(id) && id > 0,
  });
}

function useAfterReview(id: number) {
  const queryClient = useQueryClient();
  return (detail: Schemas["ProofDetail"]) => {
    queryClient.setQueryData([...PROOFS_KEY, "detail", id], detail);
    void queryClient.invalidateQueries({ queryKey: PROOFS_KEY });
    void queryClient.invalidateQueries({ queryKey: ADMIN_ORDERS_KEY });
  };
}

export function useApproveProof(id: number) {
  const api = useApi();
  const afterReview = useAfterReview(id);
  return useMutation({
    mutationFn: async (body: Schemas["ApproveProofRequest"]) =>
      unwrap(await api.POST("/admin/proofs/{id}/approve", { params: { path: { id } }, body })),
    onSuccess: afterReview,
  });
}

export function useRejectProof(id: number) {
  const api = useApi();
  const afterReview = useAfterReview(id);
  return useMutation({
    mutationFn: async (body: Schemas["RejectProofRequest"]) =>
      unwrap(await api.POST("/admin/proofs/{id}/reject", { params: { path: { id } }, body })),
    onSuccess: afterReview,
  });
}
