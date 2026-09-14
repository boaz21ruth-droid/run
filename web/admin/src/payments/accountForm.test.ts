import { describe, expect, it } from "vitest";
import { abaAccount } from "../test/fixtures";
import { emptyAccount, fromAccount, publicFileUrl, toAccountFormData } from "./accountForm";

describe("toAccountFormData", () => {
  it("文本字段去空格，全局账户 eventId 为空串，带二维码文件", () => {
    const qr = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const form = toAccountFormData(
      { ...emptyAccount(), name: " ABA USD ", accountName: " WERUN CO ", accountNoMasked: " *** 123 " },
      qr,
    );

    expect(form.get("name")).toBe("ABA USD");
    expect(form.get("provider")).toBe("ABA");
    expect(form.get("accountName")).toBe("WERUN CO");
    expect(form.get("accountNoMasked")).toBe("*** 123");
    expect(form.get("scope")).toBe("REGISTRATION");
    expect(form.get("eventId")).toBe("");
    expect(form.get("active")).toBe("true");
    expect(form.get("qr")).not.toBeNull();
    expect([...form.keys()].at(-1)).toBe("qr");
  });

  it("绑定赛事、停用、不换二维码", () => {
    const form = toAccountFormData({ ...fromAccount(abaAccount), eventId: 7, active: false }, null);

    expect(form.get("eventId")).toBe("7");
    expect(form.get("active")).toBe("false");
    expect(form.has("qr")).toBe(false);
  });

  it("fromAccount 回填与公开文件地址", () => {
    expect(fromAccount(abaAccount)).toEqual({
      name: "ABA USD 主收款户",
      provider: "ABA",
      accountName: "WERUN SPORTS CO LTD",
      accountNoMasked: "*** 123",
      scope: "REGISTRATION",
      eventId: null,
      active: true,
    });
    expect(publicFileUrl(88)).toBe("/api/files/88");
  });
});
