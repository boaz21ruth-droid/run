import { describe, expect, it } from "vitest";
import { ageOn, emptyFreeSignupValues, normalizePhone, toFreeSignupRequest, validateFreeSignup, type FreeSignupValues } from "./validate";

const filled: FreeSignupValues = {
  ...emptyFreeSignupValues,
  categoryId: "501",
  fullName: " Dara Sok ",
  phone: "+855 12-345 678",
  emergencyName: "Sok Chan",
  emergencyPhone: "+85598765432",
};

const consents = { version: "REG-TEST-v1", lang: "en" as const, checkedItems: ["rules", "health", "terms"] };

describe("ageOn", () => {
  it("比赛当天生日算满岁，前一天不算", () => {
    expect(ageOn("2014-11-15", "2026-11-15")).toBe(12);
    expect(ageOn("2014-11-16", "2026-11-15")).toBe(11);
  });

  it("2 月 29 日出生者在非闰年按 3 月 1 日满岁", () => {
    expect(ageOn("2012-02-29", "2026-02-28")).toBe(13);
    expect(ageOn("2012-02-29", "2026-03-01")).toBe(14);
    expect(ageOn("2012-02-29", "2028-02-29")).toBe(16);
  });
});

describe("normalizePhone", () => {
  it("去掉空格和连字符", () => {
    expect(normalizePhone(" +855 12-345 678 ")).toBe("+85512345678");
  });
});

describe("validateFreeSignup", () => {
  it("空表单报出全部必填项", () => {
    expect(validateFreeSignup(emptyFreeSignupValues, null, "2026-11-15")).toEqual({
      categoryId: { key: "required" },
      fullName: { key: "required" },
      phone: { key: "required" },
      emergencyName: { key: "required" },
      emergencyPhone: { key: "required" },
    });
  });

  it("手机号必须带国家区号", () => {
    const issues = validateFreeSignup({ ...filled, phone: "012345678", emergencyPhone: "abc" }, { minAge: 0 }, "2026-11-15");
    expect(issues).toEqual({ phone: { key: "phoneInvalid" }, emergencyPhone: { key: "phoneInvalid" } });
  });

  it("组别有最低年龄时出生日期必填并校验年龄", () => {
    expect(validateFreeSignup(filled, { minAge: 12 }, "2026-11-15")).toEqual({ birthDate: { key: "required" } });
    expect(validateFreeSignup({ ...filled, birthDate: "2014-11-16" }, { minAge: 12 }, "2026-11-15")).toEqual({
      birthDate: { key: "tooYoung", minAge: 12 },
    });
    expect(validateFreeSignup({ ...filled, birthDate: "2014-11-15" }, { minAge: 12 }, "2026-11-15")).toEqual({});
  });

  it("没有最低年龄时出生日期可空", () => {
    expect(validateFreeSignup(filled, { minAge: 0 }, "2026-11-15")).toEqual({});
  });
});

describe("toFreeSignupRequest", () => {
  it("去空白、规范手机号，未填的性别与出生日期不出现在请求体", () => {
    expect(toFreeSignupRequest(filled, consents)).toEqual({
      categoryId: 501,
      fullName: "Dara Sok",
      phone: "+85512345678",
      emergencyName: "Sok Chan",
      emergencyPhone: "+85598765432",
      consents,
    });
  });

  it("填写了性别与出生日期时带上", () => {
    const body = toFreeSignupRequest({ ...filled, gender: "F", birthDate: "2014-11-15" }, consents);
    expect(body.gender).toBe("F");
    expect(body.birthDate).toBe("2014-11-15");
  });
});
