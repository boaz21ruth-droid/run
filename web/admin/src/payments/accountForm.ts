import type { Schemas } from "@werun/api-client";

export interface PaymentAccountFormValues {
  name: string;
  provider: Schemas["PaymentProvider"];
  accountName: string;
  accountNoMasked: string;
  scope: Schemas["PaymentAccountScope"];
  eventId?: number | null;
  active: boolean;
}

export function emptyAccount(): PaymentAccountFormValues {
  return {
    name: "",
    provider: "ABA",
    accountName: "",
    accountNoMasked: "",
    scope: "REGISTRATION",
    eventId: null,
    active: true,
  };
}

export function fromAccount(account: Schemas["PaymentAccount"]): PaymentAccountFormValues {
  return {
    name: account.name,
    provider: account.provider,
    accountName: account.accountName,
    accountNoMasked: account.accountNoMasked,
    scope: account.scope,
    eventId: account.eventId,
    active: account.active,
  };
}

/** multipart 请求体：文本字段在前，qr 放最后；qr 为 null 时不带文件（修改时表示不换二维码） */
export function toAccountFormData(values: PaymentAccountFormValues, qr: Blob | null): FormData {
  const form = new FormData();
  form.append("name", values.name.trim());
  form.append("provider", values.provider);
  form.append("accountName", values.accountName.trim());
  form.append("accountNoMasked", values.accountNoMasked.trim());
  form.append("scope", values.scope);
  form.append("eventId", values.eventId == null ? "" : String(values.eventId));
  form.append("active", values.active ? "true" : "false");
  if (qr) {
    form.append("qr", qr);
  }
  return form;
}

/** 公开文件（收款二维码）地址，对应 getPublicFile */
export function publicFileUrl(fileId: number): string {
  return `/api/files/${fileId}`;
}
