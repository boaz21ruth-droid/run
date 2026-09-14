import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brand } from "./index";

const css = readFileSync(fileURLToPath(new URL("../tokens.css", import.meta.url)), "utf8");

function cssVar(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!match || match[1] === undefined) {
    throw new Error(`tokens.css 缺少变量 --${name}`);
  }
  return match[1].trim();
}

describe("brand", () => {
  it("与 tokens.css 中的变量保持一致", () => {
    expect(brand.primary).toBe(cssVar("brand"));
    expect(brand.primaryDeep).toBe(cssVar("brand-deep"));
    expect(brand.ink).toBe(cssVar("ink"));
    expect(brand.paper).toBe(cssVar("paper"));
    expect(`${brand.radius}px`).toBe(cssVar("r"));
  });

  it("主色是后台主题要求的 #0F66AE", () => {
    expect(brand.primary).toBe("#0F66AE");
  });
});

describe("tokens.css", () => {
  it("高棉文根元素调大字号与行高", () => {
    expect(css).toMatch(/\[data-script="khmer"\]\s*\{[^}]*--font-size-base:\s*16px/);
    expect(css).toMatch(/\[data-script="khmer"\]\s*\{[^}]*--line-height-base:\s*1\.9/);
  });

  it("内容最大宽度为 1184px", () => {
    expect(cssVar("shell-max")).toBe("1184px");
  });
});
