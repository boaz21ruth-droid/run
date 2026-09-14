import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-keys.mjs", import.meta.url));

function writeLocale(root: string, lang: string, ns: string, data: unknown) {
  mkdirSync(join(root, lang), { recursive: true });
  writeFileSync(join(root, lang, `${ns}.json`), JSON.stringify(data));
}

describe("check-keys", () => {
  it("仓库中的文案三语一致", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("发现缺失的 key 时列出文件与 key 并以 1 退出", () => {
    const root = mkdtempSync(join(tmpdir(), "werun-i18n-"));
    writeLocale(root, "zh", "common", { nav: { home: "首页", events: "赛事" } });
    writeLocale(root, "en", "common", { nav: { home: "Home", events: "Events" } });
    writeLocale(root, "km", "common", { nav: { home: "ទំព័រដើម" } });

    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("km/common.json");
    expect(result.stderr).toContain("nav.events");
  });

  it("空字符串文案也算缺失", () => {
    const root = mkdtempSync(join(tmpdir(), "werun-i18n-"));
    writeLocale(root, "zh", "user", { title: "标题" });
    writeLocale(root, "en", "user", { title: "" });
    writeLocale(root, "km", "user", { title: "ចំណងជើង" });

    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("en/user.json");
    expect(result.stderr).toContain("title");
  });

  it("缺少整个文件时报告文件不存在", () => {
    const root = mkdtempSync(join(tmpdir(), "werun-i18n-"));
    writeLocale(root, "zh", "admin", { a: "1" });
    writeLocale(root, "en", "admin", { a: "1" });

    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("km/admin.json");
  });
});
