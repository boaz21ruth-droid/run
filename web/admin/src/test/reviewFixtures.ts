import type { Schemas } from "@werun/api-client";

export const ORDER_NO = "WR7K3M9Q2A";

export const reviewerMe: Schemas["Me"] = {
  staff: { id: 5, username: "finance.lina", fullName: "Lina Sok", role: "FINANCE" },
  permissions: { event_config: "read", order_view: "read", proof_review: "write", payment_account_manage: "write" },
};

export const supportMe: Schemas["Me"] = {
  staff: { id: 6, username: "support.dara", fullName: "Dara Meas", role: "SUPPORT" },
  permissions: { order_view: "read", proof_review: "read", coupon_manage: "read" },
};

const eventName: Schemas["LocalizedText"] = {
  zh: "金边半程马拉松 2026",
  en: "Phnom Penh Half Marathon 2026",
  km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦",
};

export const orderDetail: Schemas["AdminOrderDetail"] = {
  id: 501,
  orderNo: ORDER_NO,
  eventId: 7,
  eventSlug: "phnom-penh-half-2026",
  eventName,
  eventTimezone: "Asia/Phnom_Penh",
  status: "PROOF_SUBMITTED",
  reservationState: "RESERVED",
  buyerName: "Sokha Chan",
  buyerPhone: "+85512345678",
  listAmountCents: 2500,
  discountCents: 49,
  identOffsetCents: 49,
  amountCents: 2451,
  currency: "USD",
  deadlineAt: null,
  paidAt: null,
  createdAt: "2026-09-14T02:40:00Z",
  paymentAccount: {
    id: 3,
    name: "ABA USD 主收款户",
    provider: "ABA",
    accountName: "WERUN SPORTS CO LTD",
    accountNoMasked: "*** *** 123",
    qrFileId: 31,
  },
  participants: [
    {
      registrationId: 801,
      regNo: "RG4D6F8H1J",
      categoryId: 11,
      categoryName: { zh: "半程 21K", en: "Half Marathon 21K", km: "ពាក់កណ្ដាលម៉ារ៉ាតុង 21K" },
      fullName: "Sokha Chan",
      priceRuleId: 21,
      listPriceCents: 2500,
      paidCents: 2451,
      registrationStatus: "PENDING",
      ticketCode: null,
    },
  ],
  proofs: [
    {
      id: 301,
      proofNo: "PF8H2K4M6N",
      status: "SUBMITTED",
      bankTxnRef: "ABA778899",
      declaredAmountCents: 2451,
      rejectCode: null,
      createdAt: "2026-09-14T02:56:00Z",
      reviewedAt: null,
    },
  ],
  receipts: [],
};

export const submittedProof: Schemas["Proof"] = {
  id: 301,
  proofNo: "PF8H2K4M6N",
  orderId: 501,
  orderNo: ORDER_NO,
  paymentAccountId: 3,
  fileId: 88,
  status: "SUBMITTED",
  bankTxnRef: "ABA778899",
  declaredAmountCents: 2451,
  declaredPaidAt: "2026-09-14T02:55:00Z",
  payerName: "SOKHA CHAN",
  dupFileHit: false,
  rejectCode: null,
  rejectReason: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: "2026-09-14T02:56:00Z",
};

export const proofDetail: Schemas["ProofDetail"] = { proof: submittedProof, order: orderDetail };

export const approvedDetail: Schemas["ProofDetail"] = {
  proof: { ...submittedProof, status: "APPROVED", reviewedBy: 5, reviewedAt: "2026-09-14T03:10:00Z" },
  order: {
    ...orderDetail,
    status: "PAID",
    reservationState: "CONSUMED",
    paidAt: "2026-09-14T02:55:00Z",
    proofs: [{ ...orderDetail.proofs[0]!, status: "APPROVED", reviewedAt: "2026-09-14T03:10:00Z" }],
    receipts: [{ id: 91, txnRef: "ABA778899", amountCents: 2451, receivedAt: "2026-09-14T02:55:00Z", matchStatus: "APPLIED" }],
  },
};

export const rejectedDetail: Schemas["ProofDetail"] = {
  proof: {
    ...submittedProof,
    status: "REJECTED",
    rejectCode: "OTHER",
    rejectReason: "Paid to a personal account",
    reviewedBy: 5,
    reviewedAt: "2026-09-14T03:10:00Z",
  },
  order: { ...orderDetail, status: "PROOF_REJECTED", deadlineAt: "2026-09-15T03:10:00Z" },
};

export const queueItems: Schemas["ProofQueueItem"][] = [
  { proof: submittedProof, amountCents: 2451, eventName, waitingSince: "2026-09-13T02:56:00Z", overSla: true },
  {
    proof: {
      ...submittedProof,
      id: 302,
      proofNo: "PF3J5L7P9R",
      orderId: 502,
      orderNo: "WR2B4C6D8E",
      fileId: 89,
      bankTxnRef: "ACL123456",
      declaredAmountCents: 3000,
      dupFileHit: true,
      createdAt: "2026-09-14T02:00:00Z",
    },
    amountCents: 2999,
    eventName,
    waitingSince: "2026-09-14T02:00:00Z",
    overSla: false,
  },
];

export const orderSummary: Schemas["AdminOrderSummary"] = {
  id: 501,
  orderNo: ORDER_NO,
  eventId: 7,
  eventSlug: "phnom-penh-half-2026",
  eventName,
  status: "PROOF_SUBMITTED",
  listAmountCents: 2500,
  discountCents: 49,
  identOffsetCents: 49,
  amountCents: 2451,
  currency: "USD",
  participantCount: 1,
  deadlineAt: null,
  paidAt: null,
  createdAt: "2026-09-14T02:40:00Z",
};
