import { describe, expect, it } from "vitest";
import { can, type Access, type PermissionMap } from "./can";

describe("can", () => {
  it.each<[PermissionMap | undefined, string, Access, boolean]>([
    [undefined, "event_config", "read", false],
    [{}, "event_config", "read", false],
    [{ event_config: "read" }, "event_config", "read", true],
    [{ event_config: "read" }, "event_config", "write", false],
    [{ event_config: "write" }, "event_config", "read", true],
    [{ event_config: "write" }, "event_config", "write", true],
  ])("permissions=%j 对 %s 要求 %s → %s", (permissions, permission, access, expected) => {
    expect(can(permissions, permission, access)).toBe(expected);
  });
});
