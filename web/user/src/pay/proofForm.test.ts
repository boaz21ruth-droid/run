import { describe, expect, it } from "vitest";
import { MAX_PROOF_BYTES, centsToInput, normalizeTxnRef, toProofFormData, validateProofForm } from "./proofForm";

function imageFile(type = "image/png", size = 128, name = "receipt.png"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("normalizeTxnRef", () => {
  it("去掉所有空白并转大写", () => {
    expect(normalizeTxnRef(" aba 7788\t99\n")).toBe("ABA778899");
    expect(normalizeTxnRef("　ab-12")).toBe("AB-12");
  });
});

describe("centsToInput", () => {
  it("按整数分拼出两位小数", () => {
    expect(centsToInput(3999)).toBe("39.99");
    expect(centsToInput(5)).toBe("0.05");
    expect(centsToInput(100000)).toBe("1000.00");
  });
});

describe("validateProofForm", () => {
  it("合法输入：交易号规范化、金额转分、付款时间转 ISO", () => {
    const file = imageFile();
    const result = validateProofForm({ file, txnRef: "aba 7788 99", amount: "39.99", paidAt: "2026-09-14T10:30" });
    expect(result).toEqual({
      ok: true,
      value: {
        file,
        bankTxnRef: "ABA778899",
        declaredAmountCents: 3999,
        declaredPaidAt: new Date("2026-09-14T10:30").toISOString(),
      },
    });
  });

  it("付款时间留空时为 null", () => {
    const result = validateProofForm({ file: imageFile("image/webp"), txnRef: "ABCD", amount: "10", paidAt: "" });
    expect(result.ok && result.value.declaredPaidAt).toBeNull();
  });

  it("逐项返回文案 key", () => {
    expect(validateProofForm({ file: null, txnRef: "ab 1", amount: "0", paidAt: "not-a-date" })).toEqual({
      ok: false,
      errors: {
        file: "proof.error.fileRequired",
        txnRef: "proof.error.txnRefLength",
        amount: "proof.error.amountInvalid",
        paidAt: "proof.error.paidAtInvalid",
      },
    });
  });

  it("文件类型与大小", () => {
    const gif = validateProofForm({ file: imageFile("image/gif"), txnRef: "ABCD", amount: "1", paidAt: "" });
    expect(gif.ok ? null : gif.errors.file).toBe("proof.error.fileType");

    const big = validateProofForm({ file: imageFile("image/jpeg", MAX_PROOF_BYTES + 1), txnRef: "ABCD", amount: "1", paidAt: "" });
    expect(big.ok ? null : big.errors.file).toBe("proof.error.fileTooLarge");

    const limit = validateProofForm({ file: imageFile("image/jpeg", MAX_PROOF_BYTES), txnRef: "ABCD", amount: "1", paidAt: "" });
    expect(limit.ok).toBe(true);
  });

  it("交易号超过 64 位、金额超过两位小数都不通过", () => {
    const result = validateProofForm({ file: imageFile(), txnRef: "A".repeat(65), amount: "1.234", paidAt: "" });
    expect(result.ok ? null : result.errors).toEqual({
      txnRef: "proof.error.txnRefLength",
      amount: "proof.error.amountInvalid",
    });
  });
});

describe("toProofFormData", () => {
  it("文本字段在前，文件最后；没有付款时间时不带该字段", () => {
    const file = imageFile();
    const form = toProofFormData({ file, bankTxnRef: "ABA778899", declaredAmountCents: 3999, declaredPaidAt: null });
    expect([...form.keys()]).toEqual(["bankTxnRef", "declaredAmountCents", "file"]);
    expect(form.get("declaredAmountCents")).toBe("3999");
    expect((form.get("file") as File).name).toBe("receipt.png");
  });
});
