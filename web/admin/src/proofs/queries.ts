import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@werun/api-client";
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
export const PROOF_QUEUE_REFETCH_MS = 30_000;

export function useProofQueue() {
  const api = useApi();
  return useQuery({
    queryKey: [...PROOFS_KEY, "queue", "SUBMITTED"],
    queryFn: async () => unwrap(await api.GET("/admin/proofs", { params: { query: { status: "SUBMITTED" } } })).items,
    // 多人同时审核：定时刷新，别人处理掉的凭证会自动从队列消失
    refetchInterval: PROOF_QUEUE_REFETCH_MS,
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

/**
 * 审核时撞上 409：通常是 ORDER_STATE_CONFLICT——凭证 / 订单已被其他同事处理（或跑者撤回）。
 * PROOF_TXN_REF_USED 也是 409，但它表示交易号已被别的到账记录占用，不是“被别人处理了”，单独按普通错误显示。
 */
export function isReviewConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code !== "PROOF_TXN_REF_USED";
}

/** 冲突后刷新凭证详情、队列与订单，让页面显示最新状态 */
export function useRefreshAfterConflict() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: PROOFS_KEY });
    void queryClient.invalidateQueries({ queryKey: ADMIN_ORDERS_KEY });
  };
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
