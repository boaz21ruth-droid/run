import { describe, expect, it } from "vitest";
import { emptyProfileForm, type ProfileFormValues } from "../profiles/validate";
import { daraProfile, halfMarathon } from "../test/fixtures";
import { newParticipant, type ParticipantDraft } from "./model";
import { validateDetailsStep, validateParticipantsStep } from "./validate";

const NOW = new Date(2026, 8, 14, 10, 0, 0);

function validForm(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    ...emptyProfileForm,
    fullName: "Chan Sophea",
    gender: "F",
    birthDate: "1990-05-01",
    nationality: "kh",
    idType: "PASSPORT",
    idNo: "N0 1234-567",
    phone: "+85512345678",
    emergencyName: "Sok Dara",
    emergencyPhone: "+85598765432",
    tshirtSize: "M",
    ...overrides,
  };
}

function draft(overrides: Partial<ParticipantDraft> = {}): ParticipantDraft {
  return { ...newParticipant(), categoryId: 11, ...overrides };
}

describe("validateParticipantsStep", () => {
  it("每人都选了可报名的组别时没有错误", () => {
    expect(validateParticipantsStep([draft(), draft({ categoryId: 12, profileId: 7 })], halfMarathon, [daraProfile])).toEqual({});
  });

  it("未选组别、组别已满分别提示", () => {
    const soldOut = { ...halfMarathon, categories: halfMarathon.categories.map((c) => (c.id === 12 ? { ...c, soldOut: true } : c)) };
    expect(validateParticipantsStep([draft({ categoryId: null }), draft({ categoryId: 12 })], soldOut, [])).toEqual({
      "participants[0].categoryId": { key: "profiles.errors.required" },
      "participants[1].categoryId": { key: "register.errors.soldOut" },
    });
  });

  it("同一常用参赛人不能重复添加，比赛当天未满组别最低年龄时提示", () => {
    const young = { ...daraProfile, id: 8, birthDate: "2010-11-16" };
    expect(
      validateParticipantsStep(
        [draft({ profileId: 7 }), draft({ categoryId: 12, profileId: 7 }), draft({ profileId: 8 })],
        halfMarathon,
        [daraProfile, young],
      ),
    ).toEqual({
      "participants[1].profileId": { key: "register.errors.duplicateProfile" },
      "participants[2].profileId": { key: "register.errors.tooYoung", params: { minAge: 16 } },
    });
  });
});

describe("validateDetailsStep", () => {
  it("完整资料没有错误；使用常用参赛人的不校验表单", () => {
    expect(validateDetailsStep([draft({ form: validForm() }), draft({ profileId: 7 })], halfMarathon, NOW)).toEqual({});
  });

  it("字段错误沿用 profiles.errors 文案", () => {
    const issues = validateDetailsStep([draft({ form: validForm({ fullName: "", phone: "012345" }) })], halfMarathon, NOW);
    expect(issues).toEqual({
      "participants[0].fullName": { key: "profiles.errors.required" },
      "participants[0].phone": { key: "profiles.errors.invalid" },
    });
  });

  it("比赛当天刚满最低年龄可以报名，差一天不行", () => {
    expect(validateDetailsStep([draft({ form: validForm({ birthDate: "2010-11-15" }) })], halfMarathon, NOW)).toEqual({});
    expect(validateDetailsStep([draft({ form: validForm({ birthDate: "2010-11-16" }) })], halfMarathon, NOW)).toEqual({
      "participants[0].birthDate": { key: "register.errors.tooYoung", params: { minAge: 16 } },
    });
  });

  it("同一订单内证件号（规范化后）重复时提示后出现的那位", () => {
    const issues = validateDetailsStep(
      [draft({ form: validForm({ idNo: "n0-1234 567" }) }), draft({ categoryId: 12, form: validForm({ idNo: "N01234567" }) })],
      halfMarathon,
      NOW,
    );
    expect(issues).toEqual({ "participants[1].idNo": { key: "register.errors.duplicateIdNo" } });
  });
});
