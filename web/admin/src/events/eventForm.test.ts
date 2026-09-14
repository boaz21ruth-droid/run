import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { toCreateEventRequest, toNamePath } from "./eventForm";

describe("toCreateEventRequest", () => {
  it("去除首尾空格，日期转为 YYYY-MM-DD，时间转为 ISO，未填时间为 null", () => {
    const request = toCreateEventRequest({
      slug: " phnom-penh-half-2026 ",
      eventType: "RACE",
      organizerType: "OFFICIAL",
      name: { zh: "金边半程马拉松 2026 ", en: "Phnom Penh Half Marathon 2026", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦" },
      city: " Phnom Penh",
      raceDate: dayjs("2026-11-15"),
      categories: [
        {
          code: "21K",
          name: { zh: "半程", en: "Half marathon", km: "ពាក់កណ្ដាល" },
          distanceM: 21097,
          capacity: 800,
          startAt: dayjs("2026-11-14T23:00:00Z"),
          cutoffAt: null,
        },
      ],
    });

    expect(request).toEqual({
      slug: "phnom-penh-half-2026",
      eventType: "RACE",
      organizerType: "OFFICIAL",
      name: { zh: "金边半程马拉松 2026", en: "Phnom Penh Half Marathon 2026", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦" },
      city: "Phnom Penh",
      raceDate: "2026-11-15",
      categories: [
        {
          code: "21K",
          name: { zh: "半程", en: "Half marathon", km: "ពាក់កណ្ដាល" },
          distanceM: 21097,
          capacity: 800,
          startAt: "2026-11-14T23:00:00.000Z",
          cutoffAt: null,
        },
      ],
    });
  });
});

describe("toNamePath", () => {
  it("把服务端字段路径转换为 antd NamePath", () => {
    expect(toNamePath("slug")).toEqual(["slug"]);
    expect(toNamePath("name.km")).toEqual(["name", "km"]);
    expect(toNamePath("categories[0].code")).toEqual(["categories", 0, "code"]);
  });

  it("同时接受点号形式的数组下标", () => {
    expect(toNamePath("categories.1.name.zh")).toEqual(["categories", 1, "name", "zh"]);
  });
});
