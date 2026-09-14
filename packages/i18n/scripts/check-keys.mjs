#!/usr/bin/env node
// 校验 locales/{zh,en,km}/*.json 三种语言的 key 集合完全一致，且没有空文案。
// 用法：node scripts/check-keys.mjs [locales 目录]，默认检查本包的 locales。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LANGS = ["zh", "en", "km"];
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "locales");

/** 把嵌套对象展开成 [["a.b", "文案"], ...] */
function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child !== null && typeof child === "object" ? flatten(child, path) : [[path, child]];
  });
}

const namespaces = new Set();
for (const lang of LANGS) {
  const dir = join(root, lang);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".json")) namespaces.add(file);
  }
}

const problems = [];
for (const ns of [...namespaces].sort()) {
  const entriesByLang = new Map();
  for (const lang of LANGS) {
    const file = join(root, lang, ns);
    entriesByLang.set(lang, existsSync(file) ? flatten(JSON.parse(readFileSync(file, "utf8"))) : null);
  }

  const allKeys = new Set();
  for (const entries of entriesByLang.values()) {
    for (const [key] of entries ?? []) allKeys.add(key);
  }

  for (const lang of LANGS) {
    const entries = entriesByLang.get(lang);
    if (entries === null) {
      problems.push(`${lang}/${ns}: 文件不存在`);
      continue;
    }
    const filled = new Set(entries.filter(([, text]) => typeof text === "string" && text.trim() !== "").map(([key]) => key));
    const missing = [...allKeys].filter((key) => !filled.has(key)).sort();
    if (missing.length > 0) {
      problems.push(`${lang}/${ns}: 缺少或为空 ${missing.join(", ")}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n 检查通过：${namespaces.size} 个命名空间，三种语言 key 一致`);
