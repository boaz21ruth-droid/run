import { describe, expect, it } from "vitest";
import { emptyProfileForm } from "../profiles/validate";
import { daraProfile, halfMarathon } from "../test/fixtures";
import { ageOn, newParticipant, registrationAvailable, toOrderParticipant, toQuoteParticipant, type ParticipantDraft } from "./model";

function draftWithForm(): ParticipantDraft {
  return {
    ...newParticipant(),
    categoryId: 11,
    saveAsProfile: true,
    form: {
      ...emptyProfileForm,
      fullName: " Chan Sophea ",
      gender: "F",
      birthDate: "1990-05-01",
      nationality: "kh",
      idType: "PASSPORT",
      idNo: "n0 1234-567",
      phone: "+855 12 345 678",
      email: "",
      emergencyName: "Sok Dara",
      emergencyPhone: "+85598765432",
      tshirtSize: "M",
    },
  };
}

describe("ageOn", () => {
  it("按比赛当天计算周岁", () => {
    expect(ageOn("2010-11-15", "2026-11-15")).toBe(16);
    expect(ageOn("2010-11-16", "2026-11-15")).toBe(15);
  });

  it("2 月 29 日出生者在非闰年 3 月 1 日满岁", () => {
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
    expect(ageOn("2008-02-29", "2028-02-29")).toBe(20);
  });
});

describe("registrationAvailable", () => {
  const now = new Date("2026-09-14T03:00:00Z");

  it("RACE、开关打开且在报名时间内才可报名", () => {
    expect(registrationAvailable(halfMarathon, now)).toBe(true);
    expect(registrationAvailable({ ...halfMarathon, registrationOpen: false }, now)).toBe(false);
    expect(registrationAvailable({ ...halfMarathon, eventType: "FREE_ACTIVITY" }, now)).toBe(false);
    expect(registrationAvailable({ ...halfMarathon, registrationOpensAt: "2026-09-14T04:00:00Z" }, now)).toBe(false);
    expect(registrationAvailable({ ...halfMarathon, registrationClosesAt: "2026-09-14T03:00:00Z" }, now)).toBe(false);
    expect(
      registrationAvailable({ ...halfMarathon, registrationOpensAt: "2026-09-01T00:00:00Z", registrationClosesAt: "2026-10-01T00:00:00Z" }, now),
    ).toBe(true);
  });
});

describe("toOrderParticipant", () => {
  it("选了常用参赛人时只提交组别与资料 id", () => {
    expect(toOrderParticipant({ ...newParticipant(), categoryId: 11, profileId: 7 })).toEqual({ categoryId: 11, profileId: 7 });
  });

  it("新填资料按 profiles/validate 的规则规范化，不带 isSelf", () => {
    expect(toOrderParticipant(draftWithForm())).toEqual({
      categoryId: 11,
      saveAsProfile: true,
      profile: {
        fullName: "Chan Sophea",
        gender: "F",
        birthDate: "1990-05-01",
        nationality: "KH",
        idType: "PASSPORT",
        idNo: "N01234567",
        phone: "+85512345678",
        emergencyName: "Sok Dara",
        emergencyPhone: "+85598765432",
        tshirtSize: "M",
      },
    });
  });
});

describe("toQuoteParticipant", () => {
  it("常用参赛人取已保存的国籍与生日，新资料取表单", () => {
    expect(toQuoteParticipant({ ...newParticipant(), categoryId: 12, profileId: 7 }, [daraProfile])).toEqual({
      categoryId: 12,
      nationality: "KH",
      birthDate: "1990-05-01",
    });
    expect(toQuoteParticipant(draftWithForm(), [])).toEqual({ categoryId: 11, nationality: "KH", birthDate: "1990-05-01" });
  });
});
