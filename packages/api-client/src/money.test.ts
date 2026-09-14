import { describe, expect, it } from "vitest";
import { formatUsd, parseUsdToCents } from "./index";

describe("formatUsd", () => {
  it.each([
    [2500, "$25.00"],
    [5, "$0.05"],
    [-5, "-$0.05"],
    [0, "$0.00"],
    [123456, "$1234.56"],
    [-250075, "-$2500.75"],
  ])("%i 分 → %s", (cents, expected) => {
    expect(formatUsd(cents)).toBe(expected);
  });
});

describe("parseUsdToCents", () => {
  it.each([
    ["25", 2500],
    ["25.5", 2550],
    ["25.50", 2550],
    [" 0.07 ", 7],
    ["0", 0],
    ["1999.99", 199999],
  ])("%j → %i", (input, expected) => {
    expect(parseUsdToCents(input)).toBe(expected);
  });

  it.each(["", " ", "abc", "25.505", "-1", "1e3", "25.", ".5", "$25", "1,000", "99999999999999"])(
    "%j → null",
    (input) => {
      expect(parseUsdToCents(input)).toBeNull();
    },
  );
});
