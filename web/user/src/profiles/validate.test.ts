import { describe, expect, it } from "vitest";
import { daraProfile } from "../test/fixtures";
import {
  emptyProfileForm,
  pickProfileFieldErrors,
  profileToForm,
  toProfileInput,
  validateProfileForm,
  type ProfileFormValues,
} from "./validate";

const NOW = new Date(2026, 8, 14, 10, 0, 0);

function validForm(): ProfileFormValues {
  return {
    fullName: " Chan Sreymom ",
    gender: "F",
    birthDate: "1995-02-28",
    nationality: "kh",
    idType: "PASSPORT",
    idNo: "n0 1234-9999",
    phone: "+855 11 222 333",
    email: "",
    emergencyName: "Chan Dara",
    emergencyPhone: "+85599888777",
    tshirtSize: "S",
    isSelf: false,
  };
}

describe("validateProfileForm", () => {
  it("合法输入没有错误", () => {
    expect(validateProfileForm(validForm(), { now: NOW })).toEqual({});
  });

  it("空表单列出全部必填项，邮箱除外", () => {
    expect(validateProfileForm(emptyProfileForm, { now: NOW })).toEqual({
      fullName: "required",
      gender: "required",
      birthDate: "required",
      nationality: "required",
      idType: "required",
      idNo: "required",
      phone: "required",
      emergencyName: "required",
      emergencyPhone: "required",
      tshirtSize: "required",
    });
  });

  it("编辑时证件号可以留空", () => {
    expect(validateProfileForm({ ...validForm(), idNo: "" }, { now: NOW, idNoOptional: true })).toEqual({});
  });

  it.each([
    ["fullName", "a".repeat(101)],
    ["gender", "Z"],
    ["birthDate", "1899-12-31"],
    ["birthDate", "2026-09-15"],
    ["birthDate", "1995/02/28"],
    ["nationality", "KHM"],
    ["idType", "DRIVER"],
    ["idNo", "12-3"],
    ["idNo", "AB#1234"],
    ["phone", "012345678"],
    ["phone", "+0123456789"],
    ["email", "dara@example"],
    ["emergencyName", "b".repeat(101)],
    ["emergencyPhone", "12345"],
    ["tshirtSize", "XXXL"],
  ] as const)("%s = %s 格式不正确", (field, value) => {
    expect(validateProfileForm({ ...validForm(), [field]: value }, { now: NOW })).toEqual({ [field]: "invalid" });
  });

  it("出生日期可以是今天，姓名按字符计 100 个高棉文字符合法", () => {
    expect(validateProfileForm({ ...validForm(), birthDate: "2026-09-14", fullName: "ក".repeat(100) }, { now: NOW })).toEqual({});
  });
});

describe("toProfileInput", () => {
  it("规范化并省略空的证件号与邮箱", () => {
    expect(toProfileInput(validForm())).toEqual({
      fullName: "Chan Sreymom",
      gender: "F",
      birthDate: "1995-02-28",
      nationality: "KH",
      idType: "PASSPORT",
      idNo: "N012349999",
      phone: "+85511222333",
      emergencyName: "Chan Dara",
      emergencyPhone: "+85599888777",
      tshirtSize: "S",
      isSelf: false,
    });
    const withoutIdNo = toProfileInput({ ...validForm(), idNo: " ", email: " dara@example.com " });
    expect("idNo" in withoutIdNo).toBe(false);
    expect(withoutIdNo.email).toBe("dara@example.com");
  });
});

describe("profileToForm", () => {
  it("证件号留空，其余字段带入", () => {
    expect(profileToForm(daraProfile)).toEqual({
      fullName: "Sok Dara",
      gender: "M",
      birthDate: "1990-05-01",
      nationality: "KH",
      idType: "NATIONAL_ID",
      idNo: "",
      phone: "+85512345678",
      email: "dara@example.com",
      emergencyName: "Sok Chenda",
      emergencyPhone: "+85598765432",
      tshirtSize: "M",
      isSelf: true,
    });
  });
});

describe("pickProfileFieldErrors", () => {
  it("只保留表单里存在的字段", () => {
    expect(pickProfileFieldErrors({ phone: "Invalid format.", profileId: "x", "participants[0].idNo": "y" })).toEqual({
      phone: "Invalid format.",
    });
  });
});
