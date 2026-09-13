# 04 · 前端（Task 11–15）

> 全局约束、依赖版本、跨任务契约（C14 Makefile、C15 前端包、C16 测试 ID）见 `00-overview.md`。本文件的任务假设 Task 1–10 已完成：`api/openapi/openapi.yaml` 已包含 C7 列出的全部操作与 schema。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

本文件在 00-overview 的 npm 版本表之外还用到以下包（同样锁定精确版本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@types/node` | `24.13.4` | 测试与脚本中使用 `node:fs` 等 |
| `@types/react` / `@types/react-dom` | `19.3.0` | React 类型 |
| `@testing-library/dom` | `10.4.1` | `@testing-library/react` 16 的 peer 依赖，必须显式安装 |
| `globals` | `16.5.0` | ESLint 中 Node 脚本的全局变量 |

约定：

- 共用包（`@werun/tokens`、`@werun/i18n`、`@werun/api-client`）不单独构建，`exports` 直接指向 TypeScript 源码，由 Vite / Vitest 编译。
- 所有 `package.json` 中的依赖都写精确版本（不带 `^`）。
- Makefile 配方行必须以 Tab 开头。

---

### Task 11: pnpm 工作区、ESLint 与设计令牌包

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `packages/tokens/package.json`
- Create: `packages/tokens/tsconfig.json`
- Create: `packages/tokens/tokens.css`
- Create: `packages/tokens/fonts.css`
- Create: `packages/tokens/src/index.ts`
- Test: `packages/tokens/src/index.test.ts`
- Modify: `Makefile`（替换 Task 1 的 `setup`、`lint`、`test` 目标，新增 `test-web`）

**Interfaces:**
- Consumes: Task 1 的 Makefile 目标 `lint-api`、`test-api`；`requirements/run/design-v7/build.mjs` 中的 v7 令牌。
- Produces:
  - `@werun/tokens`：`import "@werun/tokens/tokens.css"`、`import "@werun/tokens/fonts.css"`、`export const brand = { primary: "#0F66AE", primaryDeep: "#0A4D85", ink: "#101820", paper: "#F6F8FA", radius: 14 } as const`、`export type Brand = typeof brand`。
  - CSS 变量（Task 14、15 使用）：`--paper --card --sunk --ink --ink-mid --ink-mute --line --line-hard --brand --brand-fill --brand-deep --brand-tint --lime --lime-ink --sky-1 --sky-2 --sky-3 --sun --sun-tint --leaf --leaf-tint --night --night-2 --warn --warn-tint --stop --stop-tint --r --shadow --shadow-lift --sans --mono --font-size-base --line-height-base --shell-max --gutter`。
  - 根脚本：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`（`i18n:check` 在 Task 12 加入）。
  - Makefile：`setup`、`lint`、`test`、`test-web`。
  - `tsconfig.base.json`：所有前端包 `extends` 它。

- [ ] **Step 1: 创建工作区根配置**

`package.json`：

```json
{
  "name": "werun",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.34.5",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "eslint .",
    "test": "pnpm -r --if-present test",
    "build": "pnpm -r --if-present build"
  },
  "devDependencies": {
    "@eslint/js": "9.39.5",
    "eslint": "9.39.5",
    "eslint-plugin-react-hooks": "5.2.0",
    "globals": "16.5.0",
    "typescript": "5.9.3",
    "typescript-eslint": "8.70.0"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - packages/*
  - web/*
  - e2e

# pnpm 10 默认不执行依赖的安装脚本；esbuild（Vite 使用）需要执行以校验平台二进制
onlyBuiltDependencies:
  - esbuild
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`eslint.config.js`：

```js
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/src/schema.d.ts",
      "api/**",
      "docs/**",
      "requirements/**",
      "e2e/playwright-report/**",
      "e2e/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
```

`packages/tokens/package.json`：

```json
{
  "name": "@werun/tokens",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./tokens.css",
    "./fonts.css": "./fonts.css"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource/inter": "5.3.0",
    "@fontsource/noto-sans-khmer": "5.3.0"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/tokens/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 安装依赖**

Run: `corepack enable && pnpm install`
Expected: 输出末尾出现 `Done in`，根目录生成 `pnpm-lock.yaml`，无 `ERR_PNPM` 错误。

- [ ] **Step 3: 写失败的测试**

`packages/tokens/src/index.test.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `pnpm --filter @werun/tokens test`
Expected: FAIL，报错包含 `Failed to resolve import "./index"` 或 `ENOENT` 找不到 `tokens.css`。

- [ ] **Step 5: 实现令牌包**

`packages/tokens/tokens.css`（变量取自 `requirements/run/design-v7/build.mjs` 的 `:root`；中文字体改为简体字族，因为用户端中文使用简体）：

```css
:root {
  --paper: #F6F8FA;
  --card: #FFFFFF;
  --sunk: #EFF3F7;
  --ink: #101820;
  --ink-mid: #3D5468;
  --ink-mute: #5F6E7E;
  --line: #E4E9EE;
  --line-hard: #CBD5DE;
  --brand: #0F66AE;
  --brand-fill: #0877FF;
  --brand-deep: #0A4D85;
  --brand-tint: #E8F1FB;
  --lime: #D7FF3F;
  --lime-ink: #101820;
  --sky-1: #6FC1F2;
  --sky-2: #A9DCF8;
  --sky-3: #DDF1FD;
  --sun: #FFB93D;
  --sun-tint: #FFF3DD;
  --leaf: #3EB489;
  --leaf-tint: #E2F6EE;
  --night: #12395C;
  --night-2: #17486F;
  --warn: #C0770A;
  --warn-tint: #FFF3DE;
  --stop: #CE4E3B;
  --stop-tint: #FDEBE7;
  --r: 14px;
  --shadow: 0 6px 22px rgba(21, 105, 175, 0.09);
  --shadow-lift: 0 12px 32px rgba(21, 105, 175, 0.16);
  --sans: Inter, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --font-size-base: 15px;
  --line-height-base: 1.7;
  --shell-max: 1184px;
  --gutter: 16px;
}

/* 高棉文字形更高、上下标更多：换字体并加大字号与行高 */
[data-script="khmer"] {
  --sans: "Noto Sans Khmer", Inter, system-ui, sans-serif;
  --font-size-base: 16px;
  --line-height-base: 1.9;
}

/* 1024px 及以上为桌面布局（CSS 变量不能用于媒体查询，断点值在各组件中写字面量 1024px） */
@media (min-width: 1024px) {
  :root {
    --gutter: 40px;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
  -webkit-font-smoothing: antialiased;
}

a {
  color: var(--brand);
  text-decoration: none;
}

a:hover {
  color: var(--brand-deep);
}

h1,
h2,
h3,
h4,
p {
  margin: 0;
}

img {
  display: block;
  max-width: 100%;
}

:focus-visible {
  outline: 2px solid var(--brand-fill);
  outline-offset: 2px;
}
```

`packages/tokens/fonts.css`（fontsource 每个文件只含一个字重和一个字符子集，`@font-face` 自带 `unicode-range`，中文用户不会下载高棉字体）：

```css
@import "@fontsource/inter/latin-400.css";
@import "@fontsource/inter/latin-600.css";
@import "@fontsource/inter/latin-700.css";
@import "@fontsource/inter/latin-800.css";
@import "@fontsource/noto-sans-khmer/khmer-400.css";
@import "@fontsource/noto-sans-khmer/khmer-600.css";
@import "@fontsource/noto-sans-khmer/khmer-700.css";
```

`packages/tokens/src/index.ts`：

```ts
/** 供 JS 使用的品牌值（Ant Design 主题等）。必须与 tokens.css 保持一致，由单元测试校验。 */
export const brand = {
  primary: "#0F66AE",
  primaryDeep: "#0A4D85",
  ink: "#101820",
  paper: "#F6F8FA",
  radius: 14,
} as const;

export type Brand = typeof brand;
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm --filter @werun/tokens test`
Expected: PASS，`4 passed`。

- [ ] **Step 7: 类型检查与 lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 两条命令都以退出码 0 结束，无错误输出。

- [ ] **Step 8: 更新 Makefile**

把 Task 1 中 `setup`、`lint`、`test` 三个目标的定义整体替换为下面的内容，并新增 `test-web`（保留 Task 1 的 `lint-api`、`test-api` 不变；若文件顶部已有 `.PHONY` 行，把这几个目标名加进去）：

```make
.PHONY: setup lint test test-web

setup:
	corepack enable
	pnpm install
	cd api && go mod download
	test -f .env || cp .env.example .env

lint: lint-api
	pnpm lint

test: test-api test-web

test-web:
	pnpm typecheck
	pnpm test
```

Run: `make test-web`
Expected: 退出码 0，输出中 `@werun/tokens` 的测试 `4 passed`。

- [ ] **Step 9: 提交**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.js packages/tokens Makefile
git commit -F - <<'EOF'
feat(web): add pnpm workspace, eslint and design tokens package

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 12: 三语包 `@werun/i18n`

**Files:**
- Create: `packages/i18n/package.json`
- Create: `packages/i18n/tsconfig.json`
- Create: `packages/i18n/src/index.ts`
- Create: `packages/i18n/scripts/check-keys.mjs`
- Create: `packages/i18n/locales/zh/common.json`、`packages/i18n/locales/en/common.json`、`packages/i18n/locales/km/common.json`
- Create: `packages/i18n/locales/zh/user.json`、`packages/i18n/locales/en/user.json`、`packages/i18n/locales/km/user.json`
- Create: `packages/i18n/locales/zh/admin.json`、`packages/i18n/locales/en/admin.json`、`packages/i18n/locales/km/admin.json`
- Test: `packages/i18n/src/index.test.ts`
- Test: `packages/i18n/scripts/check-keys.test.ts`
- Modify: `package.json`（根脚本加 `i18n:check`）
- Modify: `Makefile`（`test-web` 加 `pnpm i18n:check`）

**Interfaces:**
- Consumes: 无。
- Produces（C15 契约，另加 `isLang`、`LANG_LABELS`、`useLang` 三个辅助导出，Task 14、15 使用）：

```ts
export type Lang = "zh" | "en" | "km";
export const LANGS: readonly Lang[];                 // ["zh", "en", "km"]
export const DEFAULT_LANG: Lang;                     // "km"
export const STORAGE_KEY: "werun.lang";
export const LANG_LABELS: Record<Lang, string>;      // { zh: "中文", en: "EN", km: "ខ្មែរ" }
export function isLang(value: unknown): value is Lang;
export function initI18n(app: "user" | "admin"): i18n;   // i18next 实例；命名空间 common + app，defaultNS = app，fallbackNS = "common"
export function setLanguage(lang: Lang): Promise<void>;
export function currentLang(): Lang;
export function applyDocumentLang(lang: Lang): void;
export function useLang(): Lang;                     // React hook，语言变化时触发重渲染
```

文案 key 清单（本任务定义，Task 14、15 **只能**使用这些 key；新增 key 必须三语同时加）。调用方式：用户端 `useTranslation("user")`，后台 `useTranslation("admin")`，通用文案写 `t("common:nav.events")`。

| 命名空间 | key |
|---|---|
| `common` | `brand.name`、`lang.label`、`nav.home`、`nav.events`、`state.loading`、`state.error`、`action.retry`、`action.back` |
| `user` | `home.title`、`home.viewAll`、`events.title`、`events.empty`、`event.date`、`event.city`、`event.categories`、`event.distance`、`event.km`（参数 `km`）、`event.capacity`、`event.start`、`event.cutoff`、`notFound.title`、`notFound.body`、`notFound.home` |
| `admin` | `login.title`、`login.username`、`login.password`、`login.submit`、`layout.logout`、`role.ADMIN`、`role.OPS`、`role.FINANCE`、`role.SUPPORT`、`role.RACE_SUPERVISOR`、`role.RACE_STAFF`、`role.PHOTOGRAPHER`、`forbidden.title`、`forbidden.body`、`events.title`、`events.create`、`events.publish`、`events.publishedToast`、`events.empty`、`events.col.name`、`events.col.date`、`events.col.city`、`events.col.status`、`events.col.actions`、`status.DRAFT`、`status.PUBLISHED`、`form.title`、`form.slug`、`form.slugHelp`、`form.eventType`、`form.organizerType`、`form.name`、`form.nameZh`、`form.nameEn`、`form.nameKm`、`form.city`、`form.raceDate`、`form.categories`、`form.addCategory`、`form.removeCategory`、`form.categoryCode`、`form.categoryName`、`form.distanceM`、`form.capacity`、`form.startAt`、`form.cutoffAt`、`form.required`、`form.submit`、`form.created`、`eventType.RACE`、`eventType.FREE_ACTIVITY`、`organizerType.OFFICIAL`、`organizerType.PARTNER` |

高棉文文案为初稿，上线前需要柬埔寨本地同事校对（与 Demo 注释一致）。

- [ ] **Step 1: 创建包配置**

`packages/i18n/package.json`：

```json
{
  "name": "@werun/i18n",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check": "node scripts/check-keys.mjs"
  },
  "dependencies": {
    "i18next": "25.10.10",
    "react-i18next": "15.7.4"
  },
  "peerDependencies": {
    "react": "19.3.0"
  },
  "devDependencies": {
    "@types/node": "24.13.4",
    "@types/react": "19.3.0",
    "jsdom": "26.1.0",
    "react": "19.3.0",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/i18n/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src", "scripts", "locales"]
}
```

Run: `pnpm install`
Expected: `Done in`，无错误。

- [ ] **Step 2: 写失败的测试**

`packages/i18n/src/index.test.ts`：

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANG,
  LANGS,
  STORAGE_KEY,
  applyDocumentLang,
  currentLang,
  initI18n,
  isLang,
  setLanguage,
} from "./index";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("lang");
  delete document.documentElement.dataset.script;
});

describe("常量", () => {
  it("只支持三种语言，默认高棉文", () => {
    expect(LANGS).toEqual(["zh", "en", "km"]);
    expect(DEFAULT_LANG).toBe("km");
    expect(STORAGE_KEY).toBe("werun.lang");
    expect(isLang("zh")).toBe(true);
    expect(isLang("zh-CN")).toBe(false);
  });
});

describe("initI18n", () => {
  it("使用 localStorage 中保存的语言，并同步 html 属性", () => {
    window.localStorage.setItem(STORAGE_KEY, "zh");
    const i18n = initI18n("user");
    expect(i18n.language).toBe("zh");
    expect(currentLang()).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");
    expect(document.documentElement.dataset.script).toBeUndefined();
    expect(i18n.t("common:nav.events")).toBe("赛事");
    expect(i18n.t("home.title")).toBe("近期赛事");
  });

  it("没有保存或保存了无效值时使用高棉文", () => {
    window.localStorage.setItem(STORAGE_KEY, "fr");
    const i18n = initI18n("admin");
    expect(i18n.language).toBe("km");
    expect(document.documentElement.lang).toBe("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
  });

  it("后台实例的默认命名空间是 admin", () => {
    window.localStorage.setItem(STORAGE_KEY, "en");
    const i18n = initI18n("admin");
    expect(i18n.t("login.submit")).toBe("Sign in");
  });
});

describe("setLanguage", () => {
  it("切换语言、写入存储并更新 html 属性", async () => {
    window.localStorage.setItem(STORAGE_KEY, "km");
    const i18n = initI18n("user");
    await setLanguage("en");
    expect(i18n.language).toBe("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dataset.script).toBeUndefined();
    expect(i18n.t("events.title")).toBe("All events");

    await setLanguage("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
  });
});

describe("applyDocumentLang", () => {
  it("只在高棉文时设置 data-script", () => {
    applyDocumentLang("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
    applyDocumentLang("zh");
    expect(document.documentElement.dataset.script).toBeUndefined();
  });
});
```

`packages/i18n/scripts/check-keys.test.ts`：

```ts
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
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @werun/i18n test`
Expected: FAIL，`index.test.ts` 报 `Failed to resolve import "./index"`，`check-keys.test.ts` 的子进程报 `Cannot find module`（状态码不是 0/1 的预期值）。

- [ ] **Step 4: 实现检查脚本**

`packages/i18n/scripts/check-keys.mjs`：

```js
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
```

- [ ] **Step 5: 写三语文案**

`packages/i18n/locales/zh/common.json`：

```json
{
  "brand": { "name": "WeRun" },
  "lang": { "label": "语言" },
  "nav": { "home": "首页", "events": "赛事" },
  "state": { "loading": "加载中…", "error": "加载失败，请稍后重试" },
  "action": { "retry": "重试", "back": "返回" }
}
```

`packages/i18n/locales/en/common.json`：

```json
{
  "brand": { "name": "WeRun" },
  "lang": { "label": "Language" },
  "nav": { "home": "Home", "events": "Events" },
  "state": { "loading": "Loading…", "error": "Couldn't load. Please try again." },
  "action": { "retry": "Retry", "back": "Back" }
}
```

`packages/i18n/locales/km/common.json`：

```json
{
  "brand": { "name": "WeRun" },
  "lang": { "label": "ភាសា" },
  "nav": { "home": "ទំព័រដើម", "events": "ព្រឹត្តិការណ៍" },
  "state": { "loading": "កំពុងផ្ទុក…", "error": "ផ្ទុកមិនបានទេ សូមព្យាយាមម្ដងទៀត" },
  "action": { "retry": "ព្យាយាមម្ដងទៀត", "back": "ត្រឡប់ក្រោយ" }
}
```

`packages/i18n/locales/zh/user.json`：

```json
{
  "home": { "title": "近期赛事", "viewAll": "查看全部赛事" },
  "events": { "title": "全部赛事", "empty": "暂时没有开放的赛事" },
  "event": {
    "date": "比赛日期",
    "city": "城市",
    "categories": "组别",
    "distance": "距离",
    "km": "{{km}} 公里",
    "capacity": "名额",
    "start": "发枪",
    "cutoff": "关门"
  },
  "notFound": { "title": "页面不存在", "body": "链接可能已经失效。", "home": "回到首页" }
}
```

`packages/i18n/locales/en/user.json`：

```json
{
  "home": { "title": "Upcoming races", "viewAll": "See all events" },
  "events": { "title": "All events", "empty": "No events are open right now" },
  "event": {
    "date": "Race day",
    "city": "City",
    "categories": "Categories",
    "distance": "Distance",
    "km": "{{km}} km",
    "capacity": "Spots",
    "start": "Start",
    "cutoff": "Cut-off"
  },
  "notFound": { "title": "Page not found", "body": "The link may be out of date.", "home": "Back to home" }
}
```

`packages/i18n/locales/km/user.json`：

```json
{
  "home": { "title": "ការរត់ខាងមុខ", "viewAll": "មើលព្រឹត្តិការណ៍ទាំងអស់" },
  "events": { "title": "ព្រឹត្តិការណ៍ទាំងអស់", "empty": "មិនទាន់មានព្រឹត្តិការណ៍បើកទេ" },
  "event": {
    "date": "ថ្ងៃប្រកួត",
    "city": "ទីក្រុង",
    "categories": "ប្រភេទ",
    "distance": "ចម្ងាយ",
    "km": "{{km}} គ.ម",
    "capacity": "ចំនួនកន្លែង",
    "start": "ចាប់ផ្ដើម",
    "cutoff": "ពេលបិទ"
  },
  "notFound": { "title": "រកមិនឃើញទំព័រ", "body": "តំណនេះប្រហែលជាហួសសុពលភាពហើយ។", "home": "ត្រឡប់ទៅទំព័រដើម" }
}
```

`packages/i18n/locales/zh/admin.json`：

```json
{
  "login": { "title": "登录 WeRun 后台", "username": "用户名", "password": "密码", "submit": "登录" },
  "layout": { "logout": "退出登录" },
  "role": {
    "ADMIN": "系统管理员",
    "OPS": "运营",
    "FINANCE": "财务",
    "SUPPORT": "客服",
    "RACE_SUPERVISOR": "现场主管",
    "RACE_STAFF": "现场工作人员",
    "PHOTOGRAPHER": "摄影师"
  },
  "forbidden": { "title": "没有访问权限", "body": "当前角色不能查看这个页面。如需开通，请联系系统管理员。" },
  "events": {
    "title": "赛事管理",
    "create": "新建赛事",
    "publish": "发布",
    "publishedToast": "赛事已发布",
    "empty": "还没有赛事",
    "col": { "name": "赛事名称", "date": "比赛日期", "city": "城市", "status": "状态", "actions": "操作" }
  },
  "status": { "DRAFT": "草稿", "PUBLISHED": "已发布" },
  "form": {
    "title": "新建赛事",
    "slug": "链接标识",
    "slugHelp": "小写字母、数字和连字符，例如 phnom-penh-half-2026",
    "eventType": "赛事类型",
    "organizerType": "主办方",
    "name": "赛事名称",
    "nameZh": "中文",
    "nameEn": "英文",
    "nameKm": "高棉文",
    "city": "城市",
    "raceDate": "比赛日期",
    "categories": "组别",
    "addCategory": "添加组别",
    "removeCategory": "删除组别",
    "categoryCode": "组别代码",
    "categoryName": "组别名称",
    "distanceM": "距离（米）",
    "capacity": "名额",
    "startAt": "发枪时间",
    "cutoffAt": "关门时间",
    "required": "必填",
    "submit": "保存草稿",
    "created": "赛事已保存为草稿"
  },
  "eventType": { "RACE": "付费赛事", "FREE_ACTIVITY": "免费活动" },
  "organizerType": { "OFFICIAL": "官方主办", "PARTNER": "合作主办" }
}
```

`packages/i18n/locales/en/admin.json`：

```json
{
  "login": { "title": "Sign in to WeRun Admin", "username": "Username", "password": "Password", "submit": "Sign in" },
  "layout": { "logout": "Sign out" },
  "role": {
    "ADMIN": "Administrator",
    "OPS": "Operations",
    "FINANCE": "Finance",
    "SUPPORT": "Support",
    "RACE_SUPERVISOR": "Race supervisor",
    "RACE_STAFF": "Race staff",
    "PHOTOGRAPHER": "Photographer"
  },
  "forbidden": { "title": "You don't have access", "body": "Your role can't view this page. Ask an administrator for access." },
  "events": {
    "title": "Events",
    "create": "New event",
    "publish": "Publish",
    "publishedToast": "Event published",
    "empty": "No events yet",
    "col": { "name": "Event", "date": "Race day", "city": "City", "status": "Status", "actions": "Actions" }
  },
  "status": { "DRAFT": "Draft", "PUBLISHED": "Published" },
  "form": {
    "title": "New event",
    "slug": "URL slug",
    "slugHelp": "Lowercase letters, numbers and hyphens, e.g. phnom-penh-half-2026",
    "eventType": "Event type",
    "organizerType": "Organizer",
    "name": "Event name",
    "nameZh": "Chinese",
    "nameEn": "English",
    "nameKm": "Khmer",
    "city": "City",
    "raceDate": "Race day",
    "categories": "Categories",
    "addCategory": "Add category",
    "removeCategory": "Remove category",
    "categoryCode": "Category code",
    "categoryName": "Category name",
    "distanceM": "Distance (m)",
    "capacity": "Spots",
    "startAt": "Start time",
    "cutoffAt": "Cut-off time",
    "required": "Required",
    "submit": "Save draft",
    "created": "Event saved as draft"
  },
  "eventType": { "RACE": "Paid race", "FREE_ACTIVITY": "Free activity" },
  "organizerType": { "OFFICIAL": "Official", "PARTNER": "Partner" }
}
```

`packages/i18n/locales/km/admin.json`：

```json
{
  "login": { "title": "ចូលប្រព័ន្ធគ្រប់គ្រង WeRun", "username": "ឈ្មោះអ្នកប្រើ", "password": "ពាក្យសម្ងាត់", "submit": "ចូល" },
  "layout": { "logout": "ចាកចេញ" },
  "role": {
    "ADMIN": "អ្នកគ្រប់គ្រងប្រព័ន្ធ",
    "OPS": "ប្រតិបត្តិការ",
    "FINANCE": "ហិរញ្ញវត្ថុ",
    "SUPPORT": "សេវាអតិថិជន",
    "RACE_SUPERVISOR": "ប្រធានទីលានប្រកួត",
    "RACE_STAFF": "បុគ្គលិកទីលានប្រកួត",
    "PHOTOGRAPHER": "អ្នកថតរូប"
  },
  "forbidden": { "title": "អ្នកមិនមានសិទ្ធិចូលប្រើទេ", "body": "តួនាទីរបស់អ្នកមិនអាចមើលទំព័រនេះបានទេ។ សូមទាក់ទងអ្នកគ្រប់គ្រងប្រព័ន្ធ។" },
  "events": {
    "title": "ការគ្រប់គ្រងព្រឹត្តិការណ៍",
    "create": "បង្កើតព្រឹត្តិការណ៍",
    "publish": "ផ្សព្វផ្សាយ",
    "publishedToast": "បានផ្សព្វផ្សាយព្រឹត្តិការណ៍",
    "empty": "មិនទាន់មានព្រឹត្តិការណ៍ទេ",
    "col": { "name": "ព្រឹត្តិការណ៍", "date": "ថ្ងៃប្រកួត", "city": "ទីក្រុង", "status": "ស្ថានភាព", "actions": "សកម្មភាព" }
  },
  "status": { "DRAFT": "សេចក្ដីព្រាង", "PUBLISHED": "បានផ្សព្វផ្សាយ" },
  "form": {
    "title": "បង្កើតព្រឹត្តិការណ៍",
    "slug": "តំណ URL",
    "slugHelp": "អក្សរតូច លេខ និងសញ្ញា - ឧ. phnom-penh-half-2026",
    "eventType": "ប្រភេទព្រឹត្តិការណ៍",
    "organizerType": "អ្នករៀបចំ",
    "name": "ឈ្មោះព្រឹត្តិការណ៍",
    "nameZh": "ភាសាចិន",
    "nameEn": "ភាសាអង់គ្លេស",
    "nameKm": "ភាសាខ្មែរ",
    "city": "ទីក្រុង",
    "raceDate": "ថ្ងៃប្រកួត",
    "categories": "ប្រភេទ",
    "addCategory": "បន្ថែមប្រភេទ",
    "removeCategory": "លុបប្រភេទ",
    "categoryCode": "កូដប្រភេទ",
    "categoryName": "ឈ្មោះប្រភេទ",
    "distanceM": "ចម្ងាយ (ម៉ែត្រ)",
    "capacity": "ចំនួនកន្លែង",
    "startAt": "ម៉ោងចាប់ផ្ដើម",
    "cutoffAt": "ម៉ោងបិទ",
    "required": "ត្រូវបំពេញ",
    "submit": "រក្សាទុកសេចក្ដីព្រាង",
    "created": "បានរក្សាទុកជាសេចក្ដីព្រាង"
  },
  "eventType": { "RACE": "ការរត់បង់ថ្លៃ", "FREE_ACTIVITY": "សកម្មភាពឥតគិតថ្លៃ" },
  "organizerType": { "OFFICIAL": "ផ្លូវការ", "PARTNER": "ដៃគូ" }
}
```

- [ ] **Step 6: 实现 `src/index.ts`**

`packages/i18n/src/index.ts`：

```ts
import i18next, { type i18n } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import enAdmin from "../locales/en/admin.json";
import enCommon from "../locales/en/common.json";
import enUser from "../locales/en/user.json";
import kmAdmin from "../locales/km/admin.json";
import kmCommon from "../locales/km/common.json";
import kmUser from "../locales/km/user.json";
import zhAdmin from "../locales/zh/admin.json";
import zhCommon from "../locales/zh/common.json";
import zhUser from "../locales/zh/user.json";

export type Lang = "zh" | "en" | "km";

export const LANGS: readonly Lang[] = ["zh", "en", "km"];
export const DEFAULT_LANG: Lang = "km";
export const STORAGE_KEY = "werun.lang";
export const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "EN", km: "ខ្មែរ" };

const resources = {
  zh: { common: zhCommon, user: zhUser, admin: zhAdmin },
  en: { common: enCommon, user: enUser, admin: enAdmin },
  km: { common: kmCommon, user: kmUser, admin: kmAdmin },
};

let instance: i18n | null = null;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLang(stored) ? stored : DEFAULT_LANG;
  } catch {
    // 部分浏览器的隐私模式禁用 localStorage，此时使用默认语言
    return DEFAULT_LANG;
  }
}

export function applyDocumentLang(lang: Lang): void {
  const root = document.documentElement;
  root.lang = lang;
  if (lang === "km") {
    root.dataset.script = "khmer";
  } else {
    delete root.dataset.script;
  }
}

export function initI18n(app: "user" | "admin"): i18n {
  const lang = readStoredLang();
  const created = i18next.createInstance();
  void created.use(initReactI18next).init({
    resources,
    lng: lang,
    fallbackLng: ["en", "zh"],
    supportedLngs: [...LANGS],
    ns: ["common", app],
    defaultNS: app,
    fallbackNS: "common",
    interpolation: { escapeValue: false },
    // 资源已内联，关闭异步初始化，调用返回时即可使用 t()
    initAsync: false,
  });
  instance = created;
  applyDocumentLang(lang);
  return created;
}

export function currentLang(): Lang {
  const lang = instance?.language;
  return isLang(lang) ? lang : readStoredLang();
}

export async function setLanguage(lang: Lang): Promise<void> {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage 不可用时语言只在本次打开期间生效
  }
  applyDocumentLang(lang);
  if (instance) {
    await instance.changeLanguage(lang);
  }
}

export function useLang(): Lang {
  const { i18n: active } = useTranslation();
  return isLang(active.language) ? active.language : DEFAULT_LANG;
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm --filter @werun/i18n test && pnpm --filter @werun/i18n check`
Expected: 测试 PASS（`index.test.ts` 6 个、`check-keys.test.ts` 4 个，共 `10 passed`）；检查脚本输出 `i18n 检查通过：3 个命名空间，三种语言 key 一致`。

- [ ] **Step 8: 接入根脚本与 Makefile**

根 `package.json` 的 `scripts` 中加入一行（其余不变）：

```json
"i18n:check": "pnpm --filter @werun/i18n check"
```

Makefile 中把 `test-web` 目标替换为：

```make
test-web:
	pnpm typecheck
	pnpm test
	pnpm i18n:check
```

Run: `pnpm typecheck && pnpm lint && make test-web`
Expected: 全部退出码 0。

- [ ] **Step 9: 提交**

```bash
git add packages/i18n package.json pnpm-lock.yaml Makefile
git commit -F - <<'EOF'
feat(web): add trilingual i18n package with key parity check

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 13: 接口客户端 `@werun/api-client`

**Files:**
- Create: `packages/api-client/package.json`
- Create: `packages/api-client/tsconfig.json`
- Create: `packages/api-client/src/schema.d.ts`（由 openapi-typescript 生成，提交进仓库）
- Create: `packages/api-client/src/errors.ts`
- Create: `packages/api-client/src/client.ts`
- Create: `packages/api-client/src/index.ts`
- Test: `packages/api-client/src/client.test.ts`
- Modify: `Makefile`（`gen` 追加 `gen-client`，新增 `gen-client` 目标）

**Interfaces:**
- Consumes: `api/openapi/openapi.yaml`（Task 5、8、10 的全部操作与 schema，见 C7）。
- Produces（C15 契约，另加 `ApiClient`、`ErrorBody`、`UNEXPECTED_RESPONSE` 三个导出）：

```ts
export type { paths, components } from "./schema";
export type Schemas = components["schemas"];
export type ApiClient = Client<paths>;               // openapi-fetch 的 Client
export interface ErrorBody { error: { code: string; message: string; fields?: Record<string, string> } }
export const UNEXPECTED_RESPONSE = "UNEXPECTED_RESPONSE"; // 响应体不是约定错误格式时的错误码（如网关 502 返回 HTML）
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
}
export interface ApiClientOptions {
  client: "user" | "admin";
  baseUrl?: string;                                   // 默认 "/api"
  getLang: () => string;
  onUnauthorized?: () => void;
}
export function createApiClient(options: ApiClientOptions): ApiClient;
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T;
```

行为约定：
- 所有请求 `credentials: "include"`，并在发送前按当前语言设置 `Accept-Language`（每次请求重新调用 `getLang()`）。
- `client: "admin"` 时额外设置 `X-WeRun-Client: admin`（后台 CSRF 防护要求）；用户端不设置。
- 任何响应状态为 401 时调用 `onUnauthorized`（响应本身仍原样返回给调用方）。
- `unwrap`：2xx 返回 `data`（204 时为 `undefined`）；否则抛 `ApiError`。
- 测试中必须使用绝对 `baseUrl`（Node 的 `Request` 不接受相对地址），浏览器中使用默认的 `/api`。
- openapi-fetch 在 `createClient` 时读取 `globalThis.fetch`，测试里必须先 `vi.stubGlobal("fetch", …)` 再创建客户端。

- [ ] **Step 1: 创建包配置**

`packages/api-client/package.json`：

```json
{
  "name": "@werun/api-client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "gen": "openapi-typescript ../../api/openapi/openapi.yaml -o src/schema.d.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "openapi-fetch": "0.17.0"
  },
  "devDependencies": {
    "openapi-typescript": "7.13.0",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/api-client/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Run: `pnpm install`
Expected: `Done in`，无错误。

- [ ] **Step 2: 生成类型**

Run: `pnpm --filter @werun/api-client gen`
Expected: 输出包含 `openapi-typescript 7.13.0` 与 `src/schema.d.ts`，退出码 0。

Run: `for p in '"/admin/events/{id}/publish"' '"/events/{slug}"' '"/admin/me"'; do grep -q "$p" packages/api-client/src/schema.d.ts && echo "ok $p" || echo "missing $p"; done`
Expected: 三行都以 `ok` 开头；出现 `missing` 说明 `openapi.yaml` 缺少该操作，先回到 Task 8 / Task 10 补齐。

- [ ] **Step 3: 写失败的测试**

`packages/api-client/src/client.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, UNEXPECTED_RESPONSE, createApiClient, unwrap } from "./index";

const BASE_URL = "http://localhost/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(respond: (request: Request) => Response) {
  const fetchMock = vi.fn(async (request: Request) => respond(request));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function firstRequest(fetchMock: ReturnType<typeof stubFetch>): Request {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("fetch 没有被调用");
  }
  return call[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient", () => {
  it("后台客户端带语言、客户端标识并携带 Cookie", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "km" });

    const result = await client.GET("/admin/events");

    expect(unwrap(result)).toEqual({ items: [] });
    const request = firstRequest(fetchMock);
    expect(request.url).toBe("http://localhost/api/admin/events");
    expect(request.headers.get("Accept-Language")).toBe("km");
    expect(request.headers.get("X-WeRun-Client")).toBe("admin");
    expect(request.credentials).toBe("include");
  });

  it("用户端客户端不带 X-WeRun-Client", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    const client = createApiClient({ client: "user", baseUrl: BASE_URL, getLang: () => "zh" });

    await client.GET("/events");

    const request = firstRequest(fetchMock);
    expect(request.headers.get("X-WeRun-Client")).toBeNull();
    expect(request.headers.get("Accept-Language")).toBe("zh");
  });

  it("每次请求都读取当前语言", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));
    let lang = "en";
    const client = createApiClient({ client: "user", baseUrl: BASE_URL, getLang: () => lang });

    await client.GET("/events");
    lang = "km";
    await client.GET("/events");

    expect(fetchMock.mock.calls[0]![0].headers.get("Accept-Language")).toBe("en");
    expect(fetchMock.mock.calls[1]![0].headers.get("Accept-Language")).toBe("km");
  });

  it("按 openapi 路径参数拼接地址并使用正确的方法", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, {
        id: 42,
        slug: "phnom-penh-half-2026",
        eventType: "RACE",
        organizerType: "OFFICIAL",
        name: { en: "Phnom Penh Half Marathon 2026" },
        city: "Phnom Penh",
        raceDate: "2026-11-15",
        status: "PUBLISHED",
        publicVisible: true,
        publishedAt: "2026-09-14T03:00:00Z",
        categories: [],
      }),
    );
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    await client.POST("/admin/events/{id}/publish", { params: { path: { id: 42 } } });

    const request = firstRequest(fetchMock);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/admin/events/42/publish");
  });

  it("收到 401 时调用 onUnauthorized", async () => {
    stubFetch(() => jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Please sign in" } }));
    const onUnauthorized = vi.fn();
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en", onUnauthorized });

    const result = await client.GET("/admin/me");

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(() => unwrap(result)).toThrow(ApiError);
  });
});

describe("unwrap", () => {
  it("把约定的错误响应转换为带错误码和字段的 ApiError", async () => {
    stubFetch(() =>
      jsonResponse(422, {
        error: { code: "VALIDATION_FAILED", message: "Check the form", fields: { slug: "Required" } },
      }),
    );
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    const result = await client.POST("/admin/events", {
      body: {
        slug: "",
        eventType: "RACE",
        organizerType: "OFFICIAL",
        name: { zh: "金边半程马拉松", en: "Phnom Penh Half Marathon", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ" },
        city: "Phnom Penh",
        raceDate: "2026-11-15",
        categories: [],
      },
    });

    let caught: unknown;
    try {
      unwrap(result);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("VALIDATION_FAILED");
    expect(apiError.message).toBe("Check the form");
    expect(apiError.fields).toEqual({ slug: "Required" });
  });

  it("响应不是约定格式时使用 UNEXPECTED_RESPONSE", async () => {
    stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }));
    const client = createApiClient({ client: "user", baseUrl: BASE_URL, getLang: () => "en" });

    const result = await client.GET("/events");

    expect(() => unwrap(result)).toThrow(
      expect.objectContaining({ status: 502, code: UNEXPECTED_RESPONSE, fields: {} }),
    );
  });

  it("204 响应返回 undefined", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const client = createApiClient({ client: "admin", baseUrl: BASE_URL, getLang: () => "en" });

    const result = await client.POST("/admin/auth/logout");

    expect(unwrap(result)).toBeUndefined();
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `pnpm --filter @werun/api-client test`
Expected: FAIL，`Failed to resolve import "./index"`。

- [ ] **Step 5: 实现错误类型**

`packages/api-client/src/errors.ts`：

```ts
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}

export const UNEXPECTED_RESPONSE = "UNEXPECTED_RESPONSE";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const error: unknown = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function toApiError(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    return new ApiError(status, body.error.code, body.error.message, body.error.fields ?? {});
  }
  return new ApiError(status, UNEXPECTED_RESPONSE, `Request failed with status ${status}`);
}

/** 2xx 返回数据；其它状态抛出 ApiError，调用方用 try/catch 或 TanStack Query 的 error 处理 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok) {
    return result.data as T;
  }
  throw toApiError(result.response.status, result.error);
}
```

- [ ] **Step 6: 实现客户端与入口**

`packages/api-client/src/client.ts`：

```ts
import createClient, { type Client, type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  client: "user" | "admin";
  baseUrl?: string;
  getLang: () => string;
  onUnauthorized?: () => void;
}

function werunMiddleware(options: ApiClientOptions): Middleware {
  return {
    onRequest({ request }) {
      request.headers.set("Accept-Language", options.getLang());
      if (options.client === "admin") {
        request.headers.set("X-WeRun-Client", "admin");
      }
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) {
        options.onUnauthorized?.();
      }
      return undefined;
    },
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "/api",
    credentials: "include",
  });
  client.use(werunMiddleware(options));
  return client;
}
```

`packages/api-client/src/index.ts`：

```ts
import type { components } from "./schema";

export { createApiClient, type ApiClient, type ApiClientOptions } from "./client";
export { ApiError, UNEXPECTED_RESPONSE, unwrap, type ErrorBody } from "./errors";
export type { components, paths } from "./schema";

export type Schemas = components["schemas"];
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm --filter @werun/api-client test`
Expected: PASS，`8 passed`。

- [ ] **Step 8: 类型检查（同时校验接口契约）**

测试文件被 `tsconfig.json` 的 `include: ["src"]` 覆盖，其中对 `/admin/events`、`/admin/events/{id}/publish`、`/admin/me`、`/admin/auth/logout`、`/events` 的调用都按生成的类型检查；`openapi.yaml` 删除或改名这些操作时这里会编译失败。

Run: `pnpm --filter @werun/api-client typecheck && pnpm lint`
Expected: 退出码 0。

- [ ] **Step 9: 接入 `make gen`**

Makefile 中把 Task 5 的 `gen` 目标替换为下面的内容，并新增 `gen-client`（保留 `gen-api` 不变）：

```make
.PHONY: gen gen-client

gen: gen-api gen-client

gen-client:
	pnpm --filter @werun/api-client gen
```

Run: `make gen && git status --short packages/api-client/src/schema.d.ts api/internal`
Expected: `make gen` 退出码 0；`git status` 对 `api/internal` 无输出（后端生成代码与已提交的一致），`schema.d.ts` 显示为 `??`（新文件，尚未提交）。

- [ ] **Step 10: 提交**

```bash
git add packages/api-client Makefile pnpm-lock.yaml
git commit -F - <<'EOF'
feat(web): add typed api client generated from openapi spec

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 14: 用户端 `web/user`

**Files:**
- Create: `web/user/package.json`
- Create: `web/user/tsconfig.json`
- Create: `web/user/vite.config.ts`
- Create: `web/user/index.html`
- Create: `web/user/src/main.tsx`
- Create: `web/user/src/routes.tsx`
- Create: `web/user/src/api.tsx`
- Create: `web/user/src/queries.ts`
- Create: `web/user/src/format.ts`
- Create: `web/user/src/components/Layout.tsx`、`web/user/src/components/Layout.module.css`
- Create: `web/user/src/components/LanguageSwitch.tsx`、`web/user/src/components/LanguageSwitch.module.css`
- Create: `web/user/src/components/EventCard.tsx`、`web/user/src/components/EventCard.module.css`
- Create: `web/user/src/components/QueryState.tsx`
- Create: `web/user/src/pages/HomePage.tsx`、`web/user/src/pages/EventsPage.tsx`、`web/user/src/pages/EventDetailPage.tsx`、`web/user/src/pages/NotFoundPage.tsx`、`web/user/src/pages/Page.module.css`
- Create: `web/user/src/telegram/telegram.ts`
- Create: `web/user/src/test/setup.ts`、`web/user/src/test/renderApp.tsx`、`web/user/src/test/fixtures.ts`
- Test: `web/user/src/format.test.ts`
- Test: `web/user/src/pages/EventsPage.test.tsx`
- Test: `web/user/src/pages/EventDetailPage.test.tsx`
- Test: `web/user/src/telegram/telegram.test.ts`

**Interfaces:**
- Consumes:
  - `@werun/tokens`：`tokens.css`、`fonts.css`，CSS 变量 `--paper --card --ink --ink-mid --ink-mute --line --brand --brand-deep --brand-tint --sunk --r --shadow --shadow-lift --mono --shell-max --gutter`。
  - `@werun/i18n`：`initI18n("user")`、`setLanguage`、`currentLang`、`useLang`、`LANGS`、`LANG_LABELS`、`type Lang`；Task 12 定义的 `common`、`user` 命名空间 key。
  - `@werun/api-client`：`createApiClient`、`unwrap`、`ApiError`、`type ApiClient`、`type Schemas`（Task 13）。
  - 接口：`GET /events` → `PublicEventList`；`GET /events/{slug}` → `PublicEvent`，不存在时 404 `EVENT_NOT_FOUND`。
- Produces:
  - `pnpm --filter @werun/user dev`（端口 5173，允许 Host `werun.localhost`，HMR 走 80 端口经 Caddy）、`build`（输出 `web/user/dist`，Task 16 的 `web.Dockerfile` 使用）。
  - 页面 data-testid：`lang-switch-zh`、`lang-switch-en`、`lang-switch-km`、`event-card`（Task 17 使用）。
  - 查询 key：`["events", lang]`、`["event", slug, lang]`（在 C15 的 `["events"]`、`["event", slug]` 后追加语言，因为接口按语言返回名称，切换语言必须重新请求）。
  - `src/telegram/telegram.ts`：`isTelegram(location?)`、`loadTelegramSdk()`、`applyTelegramTheme(webApp, root?)`、`initTelegram(router, location?)`、`TELEGRAM_SDK_URL`。

- [ ] **Step 1: 创建应用骨架配置**

`web/user/package.json`：

```json
{
  "name": "@werun/user",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "5.102.8",
    "@werun/api-client": "workspace:*",
    "@werun/i18n": "workspace:*",
    "@werun/tokens": "workspace:*",
    "i18next": "25.10.10",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-i18next": "15.7.4",
    "react-router": "7.18.3"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "6.10.0",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "jsdom": "26.1.0",
    "typescript": "5.9.3",
    "vite": "7.3.6",
    "vitest": "4.1.11"
  }
}
```

`web/user/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client", "@testing-library/jest-dom/vitest"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/user/vite.config.ts`（本地开发时浏览器访问 `http://werun.localhost`，由 Caddy 转发到 5173，所以 HMR 的客户端端口是 80；不配置 `server.proxy`，`/api` 由 Caddy 转发）：

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: ["werun.localhost"],
    hmr: { clientPort: 80 },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`web/user/index.html`：

```html
<!doctype html>
<html lang="km">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0F66AE" />
    <title>WeRun</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/user/src/test/setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
```

Run: `pnpm install`
Expected: `Done in`，无错误。

- [ ] **Step 2: 写失败的格式化测试**

`web/user/src/format.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { formatKm, formatRaceDate, formatTime } from "./format";

describe("formatTime", () => {
  it("按金边时间（UTC+7）显示 24 小时制时间", () => {
    expect(formatTime("2026-11-14T23:00:00Z", "en")).toBe("06:00");
    expect(formatTime("2026-11-15T02:30:00Z", "zh")).toBe("09:30");
  });
});

describe("formatRaceDate", () => {
  it("日期不受时区影响", () => {
    expect(formatRaceDate("2026-11-15", "en")).toBe("15 November 2026");
    expect(formatRaceDate("2026-11-15", "zh")).toBe("2026年11月15日");
  });
});

describe("formatKm", () => {
  it("米换算成公里，最多一位小数", () => {
    expect(formatKm(21097, "en")).toBe("21.1");
    expect(formatKm(10000, "en")).toBe("10");
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm --filter @werun/user test src/format.test.ts`
Expected: FAIL，`Failed to resolve import "./format"`。

- [ ] **Step 4: 实现格式化函数**

`web/user/src/format.ts`：

```ts
import type { Lang } from "@werun/i18n";

const RACE_TIME_ZONE = "Asia/Phnom_Penh";

const INTL_LOCALES: Record<Lang, string> = {
  zh: "zh-CN",
  en: "en-GB",
  km: "km-KH",
};

/** "2026-11-15" 这类纯日期按 UTC 解析并按 UTC 显示，避免跨时区时日期偏移一天 */
export function formatRaceDate(isoDate: string, lang: Lang): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** 发枪、关门时间一律按赛事所在地金边时间显示 */
export function formatTime(isoDateTime: string, lang: Lang): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: RACE_TIME_ZONE,
  }).format(new Date(isoDateTime));
}

export function formatKm(distanceM: number, lang: Lang): string {
  return new Intl.NumberFormat(INTL_LOCALES[lang], { maximumFractionDigits: 1 }).format(distanceM / 1000);
}

export function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(INTL_LOCALES[lang]).format(value);
}
```

Run: `pnpm --filter @werun/user test src/format.test.ts`
Expected: PASS，`3 passed`。

- [ ] **Step 5: 写失败的页面测试**

`web/user/src/test/fixtures.ts`：

```ts
import type { Schemas } from "@werun/api-client";

export const halfMarathon: Schemas["PublicEvent"] = {
  slug: "phnom-penh-half-2026",
  name: "Phnom Penh Half Marathon 2026",
  city: "Phnom Penh",
  raceDate: "2026-11-15",
  categories: [
    {
      code: "21K",
      name: "Half marathon",
      distanceM: 21097,
      capacity: 800,
      startAt: "2026-11-14T23:00:00Z",
      cutoffAt: "2026-11-15T02:30:00Z",
    },
    {
      code: "10K",
      name: "Fun run",
      distanceM: 10000,
      capacity: 1200,
      startAt: "2026-11-14T23:30:00Z",
      cutoffAt: "2026-11-15T02:00:00Z",
    },
  ],
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

`web/user/src/test/renderApp.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createMemoryRouter } from "react-router";
import { vi } from "vitest";
import { ApiProvider } from "../api";
import { routes } from "../routes";

export type FetchHandler = (request: Request) => Promise<Response>;

/** 用真实路由表渲染应用；fetch 被替换为 handler，返回收到的请求列表 */
export function renderApp(path: string, handler: FetchHandler) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      return handler(request);
    }),
  );
  const i18n = initI18n("user");
  const api = createApiClient({ client: "user", baseUrl: "http://localhost/api", getLang: currentLang });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>,
  );
  return { ...view, router, requests };
}
```

`web/user/src/pages/EventsPage.test.tsx`：

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { halfMarathon, jsonResponse } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

describe("EventsPage", () => {
  it("用接口返回的数据渲染赛事卡片", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderApp("/events", async () => jsonResponse(200, { items: [halfMarathon] }));

    const cards = await screen.findAllByTestId("event-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Phnom Penh Half Marathon 2026");
    expect(cards[0]).toHaveTextContent("15 November 2026");
    expect(new URL(requests[0]!.url).pathname).toBe("/api/events");
    expect(requests[0]!.headers.get("Accept-Language")).toBe("en");
    expect(screen.getByRole("heading", { name: "All events" })).toBeInTheDocument();
  });

  it("没有赛事时显示空状态", async () => {
    window.localStorage.setItem("werun.lang", "zh");
    renderApp("/events", async () => jsonResponse(200, { items: [] }));
    expect(await screen.findByText("暂时没有开放的赛事")).toBeInTheDocument();
  });

  it("接口失败时显示错误和重试按钮", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events", async () => new Response("bad gateway", { status: 502 }));
    expect(await screen.findByText("Couldn't load. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("切换语言后更新 html lang 并用新语言重新请求", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderApp("/events", async () => jsonResponse(200, { items: [halfMarathon] }));
    await screen.findAllByTestId("event-card");

    await userEvent.click(screen.getByTestId("lang-switch-km"));

    expect(document.documentElement.lang).toBe("km");
    expect(document.documentElement.dataset.script).toBe("khmer");
    await waitFor(() => {
      expect(requests.at(-1)!.headers.get("Accept-Language")).toBe("km");
    });
    expect(screen.getByTestId("lang-switch-km")).toHaveAttribute("aria-pressed", "true");
  });
});
```

`web/user/src/pages/EventDetailPage.test.tsx`：

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { halfMarathon, jsonResponse } from "../test/fixtures";
import { renderApp } from "../test/renderApp";

describe("EventDetailPage", () => {
  it("显示组别的距离、名额与金边时间", async () => {
    window.localStorage.setItem("werun.lang", "en");
    const { requests } = renderApp("/events/phnom-penh-half-2026", async () => jsonResponse(200, halfMarathon));

    expect(await screen.findByRole("heading", { name: "Phnom Penh Half Marathon 2026" })).toBeInTheDocument();
    expect(new URL(requests[0]!.url).pathname).toBe("/api/events/phnom-penh-half-2026");

    const row = screen.getByRole("row", { name: /Half marathon/ });
    expect(row).toHaveTextContent("21.1 km");
    expect(row).toHaveTextContent("800");
    expect(row).toHaveTextContent("06:00");
    expect(row).toHaveTextContent("09:30");
  });

  it("赛事不存在时显示 404 页面", async () => {
    window.localStorage.setItem("werun.lang", "en");
    renderApp("/events/nope", async () =>
      jsonResponse(404, { error: { code: "EVENT_NOT_FOUND", message: "Event not found" } }),
    );
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `pnpm --filter @werun/user test src/pages`
Expected: FAIL，`Failed to resolve import "../api"`（以及 `../routes`）。

- [ ] **Step 7: 实现 API 上下文、查询与路由**

`web/user/src/api.tsx`：

```tsx
import type { ApiClient } from "@werun/api-client";
import { createContext, useContext, type ReactNode } from "react";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error("useApi 必须在 ApiProvider 内使用");
  }
  return client;
}
```

`web/user/src/queries.ts`：

```ts
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useApi } from "./api";

export function usePublicEvents() {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["events", lang],
    queryFn: async () => unwrap(await api.GET("/events")).items,
  });
}

export function usePublicEvent(slug: string) {
  const api = useApi();
  const lang = useLang();
  return useQuery({
    queryKey: ["event", slug, lang],
    queryFn: async () => unwrap(await api.GET("/events/{slug}", { params: { path: { slug } } })),
  });
}
```

`web/user/src/routes.tsx`：

```tsx
import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "events", element: <EventsPage /> },
      { path: "events/:slug", element: <EventDetailPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
```

- [ ] **Step 8: 实现布局与组件**

`web/user/src/components/Layout.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet } from "react-router";
import styles from "./Layout.module.css";
import { LanguageSwitch } from "./LanguageSwitch";

export function Layout() {
  const { t } = useTranslation("user");
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? `${styles.navLink} ${styles.active}` : styles.navLink);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link to="/" className={styles.brand}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmark}>{t("common:brand.name")}</span>
          </Link>
          <nav className={styles.nav}>
            <NavLink to="/" end className={navClass}>
              {t("common:nav.home")}
            </NavLink>
            <NavLink to="/events" className={navClass}>
              {t("common:nav.events")}
            </NavLink>
          </nav>
          <LanguageSwitch />
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
```

`web/user/src/components/Layout.module.css`：

```css
.app {
  min-height: 100vh;
  min-height: var(--tg-viewport-height, 100vh);
}

.header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(246, 248, 250, 0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}

.headerInner {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: var(--shell-max);
  margin: 0 auto;
  padding: 10px var(--gutter);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink);
}

.mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--brand-fill);
}

.wordmark {
  font-weight: 800;
  font-size: 19px;
  letter-spacing: -0.02em;
  line-height: 1;
}

.nav {
  display: none;
}

.navLink {
  color: var(--ink-mid);
  font-size: 14px;
  font-weight: 500;
  padding: 4px 0;
  border-bottom: 2px solid transparent;
}

.active {
  color: var(--brand);
  border-bottom-color: var(--brand-fill);
}

.main {
  max-width: var(--shell-max);
  margin: 0 auto;
  padding: 20px var(--gutter) 48px;
}

@media (min-width: 1024px) {
  .nav {
    display: flex;
    gap: 28px;
    margin-left: auto;
  }
}
```

`web/user/src/components/LanguageSwitch.tsx`：

```tsx
import { LANGS, LANG_LABELS, setLanguage, useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import styles from "./LanguageSwitch.module.css";

export function LanguageSwitch() {
  const { t } = useTranslation("common");
  const active = useLang();

  return (
    <div className={styles.switch} role="group" aria-label={t("lang.label")}>
      {LANGS.map((lang) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          data-testid={`lang-switch-${lang}`}
          aria-pressed={lang === active}
          className={lang === active ? `${styles.option} ${styles.on}` : styles.option}
          onClick={() => void setLanguage(lang)}
        >
          {LANG_LABELS[lang]}
        </button>
      ))}
    </div>
  );
}
```

`web/user/src/components/LanguageSwitch.module.css`：

```css
.switch {
  display: flex;
  gap: 2px;
  margin-left: auto;
  padding: 2px;
  background: var(--sunk);
  border: 1px solid var(--line);
  border-radius: 100px;
}

.option {
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 100px;
  background: transparent;
  color: var(--ink-mute);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.option[lang="km"] {
  font-family: "Noto Sans Khmer", var(--sans);
}

.on {
  background: var(--card);
  color: var(--ink);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 24, 32, 0.08);
}

@media (min-width: 1024px) {
  .switch {
    margin-left: 0;
  }
}
```

`web/user/src/components/EventCard.tsx`：

```tsx
import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatKm, formatRaceDate } from "../format";
import styles from "./EventCard.module.css";

export function EventCard({ event }: { event: Schemas["PublicEvent"] }) {
  const { t } = useTranslation("user");
  const lang = useLang();

  return (
    <Link to={`/events/${event.slug}`} className={styles.card} data-testid="event-card">
      <p className={styles.date}>{formatRaceDate(event.raceDate, lang)}</p>
      <h3 className={styles.name}>{event.name}</h3>
      <p className={styles.city}>{event.city}</p>
      <ul className={styles.distances}>
        {event.categories.map((category) => (
          <li key={category.code} className={styles.distance}>
            {t("event.km", { km: formatKm(category.distanceM, lang) })}
          </li>
        ))}
      </ul>
    </Link>
  );
}
```

`web/user/src/components/EventCard.module.css`：

```css
.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}

.card:hover {
  color: var(--ink);
  box-shadow: var(--shadow-lift);
  transform: translateY(-1px);
}

@media (prefers-reduced-motion: reduce) {
  .card,
  .card:hover {
    transition: none;
    transform: none;
  }
}

.date {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--brand);
  letter-spacing: 0.04em;
}

.name {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
}

.city {
  font-size: 14px;
  color: var(--ink-mid);
}

.distances {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.distance {
  padding: 2px 9px;
  border-radius: 6px;
  background: var(--brand-tint);
  color: var(--brand-deep);
  font-size: 12px;
  font-weight: 700;
}
```

`web/user/src/components/QueryState.tsx`（加载、失败、重试三种状态统一展示）：

```tsx
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import styles from "../pages/Page.module.css";

export function QueryState<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  const { t } = useTranslation("common");

  if (query.isPending) {
    return <p className={styles.muted}>{t("state.loading")}</p>;
  }
  if (query.isError) {
    return (
      <div className={styles.error} role="alert">
        <p>{t("state.error")}</p>
        <button type="button" className={styles.retry} onClick={() => void query.refetch()}>
          {t("action.retry")}
        </button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}
```

- [ ] **Step 9: 实现页面**

`web/user/src/pages/Page.module.css`：

```css
.title {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.35;
  margin-bottom: 16px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.muted {
  color: var(--ink-mute);
}

.error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--stop-tint);
  color: var(--stop);
}

.retry {
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid var(--brand);
  border-radius: 100px;
  background: var(--card);
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.more {
  display: inline-flex;
  margin-top: 16px;
  font-weight: 600;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin-bottom: 20px;
  color: var(--ink-mid);
}

.tableWrap {
  overflow-x: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.table th {
  padding: 10px 12px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-mute);
  background: var(--sunk);
  white-space: nowrap;
}

.table td {
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  white-space: nowrap;
}

.num {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

@media (min-width: 1024px) {
  .title {
    font-size: 30px;
  }

  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
  }
}
```

`web/user/src/pages/HomePage.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { EventCard } from "../components/EventCard";
import { QueryState } from "../components/QueryState";
import { usePublicEvents } from "../queries";
import styles from "./Page.module.css";

const UPCOMING_LIMIT = 3;

export function HomePage() {
  const { t } = useTranslation("user");
  const events = usePublicEvents();

  return (
    <section>
      <h1 className={styles.title}>{t("home.title")}</h1>
      <QueryState query={events}>
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted}>{t("events.empty")}</p>
          ) : (
            <>
              <div className={styles.grid}>
                {items.slice(0, UPCOMING_LIMIT).map((event) => (
                  <EventCard key={event.slug} event={event} />
                ))}
              </div>
              <Link to="/events" className={styles.more}>
                {t("home.viewAll")}
              </Link>
            </>
          )
        }
      </QueryState>
    </section>
  );
}
```

`web/user/src/pages/EventsPage.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { EventCard } from "../components/EventCard";
import { QueryState } from "../components/QueryState";
import { usePublicEvents } from "../queries";
import styles from "./Page.module.css";

export function EventsPage() {
  const { t } = useTranslation("user");
  const events = usePublicEvents();

  return (
    <section>
      <h1 className={styles.title}>{t("events.title")}</h1>
      <QueryState query={events}>
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted}>{t("events.empty")}</p>
          ) : (
            <div className={styles.grid}>
              {items.map((event) => (
                <EventCard key={event.slug} event={event} />
              ))}
            </div>
          )
        }
      </QueryState>
    </section>
  );
}
```

`web/user/src/pages/EventDetailPage.tsx`：

```tsx
import { ApiError } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { QueryState } from "../components/QueryState";
import { formatKm, formatNumber, formatRaceDate, formatTime } from "../format";
import { usePublicEvent } from "../queries";
import { NotFoundPage } from "./NotFoundPage";
import styles from "./Page.module.css";

export function EventDetailPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation("user");
  const lang = useLang();
  const event = usePublicEvent(slug);

  if (event.error instanceof ApiError && event.error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <QueryState query={event}>
      {(data) => (
        <article>
          <h1 className={styles.title}>{data.name}</h1>
          <p className={styles.meta}>
            <span>
              {t("event.date")}：{formatRaceDate(data.raceDate, lang)}
            </span>
            <span>
              {t("event.city")}：{data.city}
            </span>
          </p>
          <h2 className={styles.title}>{t("event.categories")}</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t("event.categories")}</th>
                  <th scope="col">{t("event.distance")}</th>
                  <th scope="col">{t("event.capacity")}</th>
                  <th scope="col">{t("event.start")}</th>
                  <th scope="col">{t("event.cutoff")}</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((category) => (
                  <tr key={category.code}>
                    <th scope="row">{category.name}</th>
                    <td className={styles.num}>{t("event.km", { km: formatKm(category.distanceM, lang) })}</td>
                    <td className={styles.num}>{formatNumber(category.capacity, lang)}</td>
                    <td className={styles.num}>{formatTime(category.startAt, lang)}</td>
                    <td className={styles.num}>{formatTime(category.cutoffAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </QueryState>
  );
}
```

`web/user/src/pages/NotFoundPage.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import styles from "./Page.module.css";

export function NotFoundPage() {
  const { t } = useTranslation("user");
  return (
    <section>
      <h1 className={styles.title}>{t("notFound.title")}</h1>
      <p className={styles.muted}>{t("notFound.body")}</p>
      <Link to="/" className={styles.more}>
        {t("notFound.home")}
      </Link>
    </section>
  );
}
```

- [ ] **Step 10: 运行页面测试，确认通过**

Run: `pnpm --filter @werun/user test src/pages src/format.test.ts`
Expected: PASS，`EventsPage.test.tsx` 4 个、`EventDetailPage.test.tsx` 2 个、`format.test.ts` 3 个，共 `9 passed`。

- [ ] **Step 11: 写失败的 Telegram 适配测试**

`web/user/src/telegram/telegram.test.ts`：

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_SDK_URL, applyTelegramTheme, initTelegram, isTelegram, type RouterLike, type TelegramWebApp } from "./telegram";

function fakeWebApp(): TelegramWebApp {
  return {
    ready: vi.fn(),
    expand: vi.fn(),
    themeParams: { bg_color: "#ffffff", button_color: "#0f66ae" },
    viewportStableHeight: 640,
    onEvent: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn() },
  };
}

function fakeRouter(pathname: string) {
  let subscriber: ((state: { location: { pathname: string } }) => void) | undefined;
  const router: RouterLike = {
    state: { location: { pathname } },
    subscribe: (fn) => {
      subscriber = fn;
      return () => undefined;
    },
    navigate: vi.fn(async () => undefined),
  };
  return { router, emit: (path: string) => subscriber?.({ location: { pathname: path } }) };
}

afterEach(() => {
  delete window.Telegram;
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

describe("isTelegram", () => {
  it("只在地址带 tgWebAppData 时返回 true", () => {
    expect(isTelegram({ hash: "", search: "" })).toBe(false);
    expect(isTelegram({ hash: "#tgWebAppData=query_id%3DAA", search: "" })).toBe(true);
    expect(isTelegram({ hash: "", search: "?tgWebAppData=abc" })).toBe(true);
  });
});

describe("initTelegram", () => {
  it("不在 Telegram 中时什么都不做，也不加载 SDK", async () => {
    const { router } = fakeRouter("/");
    await expect(initTelegram(router, { hash: "", search: "" })).resolves.toBe(false);
    expect(document.querySelector(`script[src="${TELEGRAM_SDK_URL}"]`)).toBeNull();
  });

  it("在 Telegram 中调用 ready、expand，并同步主题与返回按钮", async () => {
    const webApp = fakeWebApp();
    window.Telegram = { WebApp: webApp };
    const { router, emit } = fakeRouter("/");

    await expect(initTelegram(router, { hash: "#tgWebAppData=abc", search: "" })).resolves.toBe(true);

    expect(webApp.ready).toHaveBeenCalledOnce();
    expect(webApp.expand).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue("--tg-bg-color")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--tg-viewport-height")).toBe("640px");
    expect(webApp.BackButton.hide).toHaveBeenCalled();

    emit("/events");
    expect(webApp.BackButton.show).toHaveBeenCalled();

    const onBack = vi.mocked(webApp.BackButton.onClick).mock.calls[0]![0];
    onBack();
    expect(router.navigate).toHaveBeenCalledWith(-1);
  });
});

describe("applyTelegramTheme", () => {
  it("把 themeParams 的下划线名转换为 CSS 变量", () => {
    const webApp = fakeWebApp();
    applyTelegramTheme(webApp);
    expect(document.documentElement.style.getPropertyValue("--tg-button-color")).toBe("#0f66ae");
  });
});
```

Run: `pnpm --filter @werun/user test src/telegram`
Expected: FAIL，`Failed to resolve import "./telegram"`。

- [ ] **Step 12: 实现 Telegram 适配层**

`web/user/src/telegram/telegram.ts`：

```ts
/**
 * Telegram Mini App 适配。只在 URL 带 tgWebAppData 时加载官方 SDK，普通浏览器不下载任何脚本。
 * initData 的服务端校验与跑者登录一起做，不在这里。
 */
export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js";

export interface TelegramWebApp {
  ready(): void;
  expand(): void;
  themeParams: Record<string, string | undefined>;
  viewportStableHeight: number;
  onEvent(event: "themeChanged" | "viewportChanged", handler: () => void): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

/** react-router 数据路由器中本适配层用到的部分 */
export interface RouterLike {
  state: { location: { pathname: string } };
  subscribe(fn: (state: { location: { pathname: string } }) => void): () => void;
  navigate(delta: number): Promise<void> | void;
}

type LocationLike = Pick<Location, "hash" | "search">;

export function isTelegram(location: LocationLike = window.location): boolean {
  return location.hash.includes("tgWebAppData") || location.search.includes("tgWebAppData");
}

export function loadTelegramSdk(): Promise<TelegramWebApp> {
  if (window.Telegram?.WebApp) {
    return Promise.resolve(window.Telegram.WebApp);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TELEGRAM_SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.Telegram?.WebApp) {
        resolve(window.Telegram.WebApp);
      } else {
        reject(new Error("Telegram SDK 已加载，但 window.Telegram.WebApp 不存在"));
      }
    };
    script.onerror = () => reject(new Error(`无法加载 ${TELEGRAM_SDK_URL}`));
    document.head.appendChild(script);
  });
}

export function applyTelegramTheme(webApp: TelegramWebApp, root: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(webApp.themeParams)) {
    if (value) {
      root.style.setProperty(`--tg-${key.replaceAll("_", "-")}`, value);
    }
  }
  root.style.setProperty("--tg-viewport-height", `${webApp.viewportStableHeight}px`);
}

export async function initTelegram(router: RouterLike, location: LocationLike = window.location): Promise<boolean> {
  if (!isTelegram(location)) {
    return false;
  }
  const webApp = await loadTelegramSdk();
  webApp.ready();
  webApp.expand();

  applyTelegramTheme(webApp);
  webApp.onEvent("themeChanged", () => applyTelegramTheme(webApp));
  webApp.onEvent("viewportChanged", () => applyTelegramTheme(webApp));

  const syncBackButton = (pathname: string) => {
    if (pathname === "/") {
      webApp.BackButton.hide();
    } else {
      webApp.BackButton.show();
    }
  };
  syncBackButton(router.state.location.pathname);
  router.subscribe((state) => syncBackButton(state.location.pathname));
  webApp.BackButton.onClick(() => {
    void router.navigate(-1);
  });
  return true;
}
```

Run: `pnpm --filter @werun/user test src/telegram`
Expected: PASS，`4 passed`。

- [ ] **Step 13: 实现入口 `main.tsx`**

`web/user/src/main.tsx`：

```tsx
import "@werun/tokens/tokens.css";
import "@werun/tokens/fonts.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createBrowserRouter } from "react-router";
import { ApiProvider } from "./api";
import { routes } from "./routes";
import { initTelegram } from "./telegram/telegram";

const i18n = initI18n("user");
const api = createApiClient({ client: "user", getLang: currentLang });
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});
const router = createBrowserRouter(routes);

initTelegram(router).catch((error: unknown) => {
  // SDK 加载失败不影响网页本身可用
  console.error(error);
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html 缺少 #root 节点");
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>
  </StrictMode>,
);
```

- [ ] **Step 14: 全量验证**

Run: `pnpm --filter @werun/user test && pnpm --filter @werun/user build && pnpm lint`
Expected: 测试 `13 passed`；`vite build` 输出 `dist/index.html` 与 `dist/assets/*.js`、`*.css`、`*.woff2`，退出码 0；lint 无错误。

- [ ] **Step 15: 提交**

```bash
git add web/user pnpm-lock.yaml
git commit -F - <<'EOF'
feat(user): add user web app with events pages and telegram adapter

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```

---

### Task 15: 后台 `web/admin`

**Files:**
- Create: `web/admin/package.json`
- Create: `web/admin/tsconfig.json`
- Create: `web/admin/vite.config.ts`
- Create: `web/admin/index.html`
- Create: `web/admin/src/main.tsx`
- Create: `web/admin/src/bootstrap.tsx`
- Create: `web/admin/src/routes.tsx`
- Create: `web/admin/src/api.tsx`
- Create: `web/admin/src/providers/AppProviders.tsx`
- Create: `web/admin/src/providers/AntdProvider.tsx`
- Create: `web/admin/src/auth/can.ts`
- Create: `web/admin/src/auth/useMe.ts`
- Create: `web/admin/src/auth/RequireAuth.tsx`
- Create: `web/admin/src/auth/RequirePermission.tsx`
- Create: `web/admin/src/layout/AppLayout.tsx`
- Create: `web/admin/src/layout/LanguageSwitch.tsx`
- Create: `web/admin/src/events/queries.ts`
- Create: `web/admin/src/events/eventForm.ts`
- Create: `web/admin/src/events/localize.ts`
- Create: `web/admin/src/pages/LoginPage.tsx`
- Create: `web/admin/src/pages/ForbiddenPage.tsx`
- Create: `web/admin/src/pages/EventsPage.tsx`
- Create: `web/admin/src/pages/EventCreatePage.tsx`
- Create: `web/admin/src/test/setup.ts`、`web/admin/src/test/fixtures.ts`、`web/admin/src/test/renderAdminApp.tsx`
- Test: `web/admin/src/auth/can.test.ts`
- Test: `web/admin/src/events/eventForm.test.ts`
- Test: `web/admin/src/app.test.tsx`

**Interfaces:**
- Consumes:
  - `@werun/tokens`：`brand`、`tokens.css`、`fonts.css`。
  - `@werun/i18n`：`initI18n("admin")`、`setLanguage`、`currentLang`、`useLang`、`LANGS`、`LANG_LABELS`、`type Lang`；Task 12 定义的 `common`、`admin` 命名空间 key。
  - `@werun/api-client`：`createApiClient`、`unwrap`、`ApiError`、`type ApiClient`、`type Schemas`。
  - 接口：`POST /admin/auth/login`（200 `Me`）、`POST /admin/auth/logout`（204）、`GET /admin/me`（200 `Me`，未登录 401）、`GET /admin/events`（200 `AdminEventList`）、`POST /admin/events`（201 `AdminEvent`，校验失败 422 带 `fields`）、`POST /admin/events/{id}/publish`（200 `AdminEvent`）。
  - 服务端 `ErrorResponse.error.fields` 的 key 为请求 JSON 的字段路径：`slug`、`name.km`、`categories[0].code`（也接受 `categories.0.code`）。
- Produces:
  - `pnpm --filter @werun/admin dev`（端口 5174，允许 Host `admin.werun.localhost`，HMR 走 80 端口）、`build`（输出 `web/admin/dist`，Task 16 使用）。
  - data-testid（C16）：`login-username`、`login-password`、`login-submit`、`event-create-button`、`event-form-submit`、`event-publish-<slug>`、`forbidden-page`、`lang-switch-zh/en/km`。
  - 新建赛事表单 `name="event"`，antd 生成的输入框 id（Task 17 用来填表）：`event_slug`、`event_eventType`（默认 `RACE`）、`event_organizerType`（默认 `OFFICIAL`）、`event_name_zh`、`event_name_en`、`event_name_km`、`event_city`、`event_raceDate`（格式 `YYYY-MM-DD`）、`event_categories_0_code`、`event_categories_0_distanceM`、`event_categories_0_capacity`、`event_categories_0_name_zh`、`event_categories_0_name_en`、`event_categories_0_name_km`、`event_categories_0_startAt`、`event_categories_0_cutoffAt`（格式 `YYYY-MM-DD HH:mm`，浏览器本地时区）。表单默认带一个空组别。
  - 路由：`/login`、`/events`（需要 `event_config` 读）、`/events/new`（需要 `event_config` 写）；`/` 与未知路径跳转 `/events`。
  - 查询 key：`["me"]`、`["admin", "events"]`。
  - `can(permissions, permission, access): boolean`。

说明：antd 5 默认只声明支持 React 16–18。在 React 19 下必须在入口最先导入官方兼容包 `@ant-design/v5-patch-for-react-19`（版本 `1.0.3`），否则按钮水波纹、`message` 等依赖旧渲染 API 的功能会报警告或失效。

- [ ] **Step 1: 创建应用骨架配置**

`web/admin/package.json`：

```json
{
  "name": "@werun/admin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@ant-design/icons": "5.6.1",
    "@ant-design/v5-patch-for-react-19": "1.0.3",
    "@tanstack/react-query": "5.102.8",
    "@werun/api-client": "workspace:*",
    "@werun/i18n": "workspace:*",
    "@werun/tokens": "workspace:*",
    "antd": "5.29.3",
    "dayjs": "1.11.23",
    "i18next": "25.10.10",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-i18next": "15.7.4",
    "react-router": "7.18.3"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "6.10.0",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "jsdom": "26.1.0",
    "typescript": "5.9.3",
    "vite": "7.3.6",
    "vitest": "4.1.11"
  }
}
```

`web/admin/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client", "@testing-library/jest-dom/vitest"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/admin/vite.config.ts`：

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    allowedHosts: ["admin.werun.localhost"],
    hmr: { clientPort: 80 },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // antd 组件在 jsdom 中渲染较慢
    testTimeout: 15_000,
  },
});
```

`web/admin/index.html`：

```html
<!doctype html>
<html lang="km">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>WeRun Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/admin/src/test/setup.ts`：

```ts
import "@ant-design/v5-patch-for-react-19";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// antd 的栅格与 Sider 断点依赖 matchMedia，jsdom 没有实现
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
```

Run: `pnpm install`
Expected: `Done in`，无错误。

- [ ] **Step 2: 写失败的纯函数测试**

`web/admin/src/auth/can.test.ts`：

```ts
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
```

`web/admin/src/events/eventForm.test.ts`：

```ts
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
```

Run: `pnpm --filter @werun/admin test src/auth src/events`
Expected: FAIL，`Failed to resolve import "./can"` 与 `Failed to resolve import "./eventForm"`。

- [ ] **Step 3: 实现纯函数**

`web/admin/src/auth/can.ts`：

```ts
import type { Schemas } from "@werun/api-client";

export type Access = Schemas["Access"];
export type PermissionMap = Schemas["Me"]["permissions"];

export const PERM_EVENT_CONFIG = "event_config";
export const PERM_EVENT_PUBLISH = "event_publish";

/** 与后端 iam.Allowed 规则一致：要求读时，读或写权限都可以；要求写时，必须有写权限 */
export function can(permissions: PermissionMap | undefined, permission: string, access: Access): boolean {
  const granted = permissions?.[permission];
  if (granted === undefined) {
    return false;
  }
  return access === "read" || granted === "write";
}
```

`web/admin/src/events/eventForm.ts`：

```ts
import type { Schemas } from "@werun/api-client";
import type { Dayjs } from "dayjs";

export interface LocalizedValues {
  zh: string;
  en: string;
  km: string;
}

export interface CategoryFormValues {
  code: string;
  name: LocalizedValues;
  distanceM: number;
  capacity: number;
  startAt?: Dayjs | null;
  cutoffAt?: Dayjs | null;
}

export interface EventFormValues {
  slug: string;
  eventType: Schemas["CreateEventRequest"]["eventType"];
  organizerType: Schemas["CreateEventRequest"]["organizerType"];
  name: LocalizedValues;
  city: string;
  raceDate: Dayjs;
  categories?: CategoryFormValues[];
}

export function emptyCategory(): Partial<CategoryFormValues> {
  return { name: { zh: "", en: "", km: "" } };
}

function trimText(text: LocalizedValues): LocalizedValues {
  return { zh: text.zh.trim(), en: text.en.trim(), km: text.km.trim() };
}

export function toCreateEventRequest(values: EventFormValues): Schemas["CreateEventRequest"] {
  return {
    slug: values.slug.trim(),
    eventType: values.eventType,
    organizerType: values.organizerType,
    name: trimText(values.name),
    city: values.city.trim(),
    raceDate: values.raceDate.format("YYYY-MM-DD"),
    categories: (values.categories ?? []).map((category) => ({
      code: category.code.trim(),
      name: trimText(category.name),
      distanceM: category.distanceM,
      capacity: category.capacity,
      startAt: category.startAt ? category.startAt.toISOString() : null,
      cutoffAt: category.cutoffAt ? category.cutoffAt.toISOString() : null,
    })),
  };
}

/** 服务端字段路径 → antd Form NamePath："categories[0].code" 与 "categories.0.code" 都得到 ["categories", 0, "code"] */
export function toNamePath(field: string): (string | number)[] {
  return field
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((part) => part !== "")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}
```

`web/admin/src/events/localize.ts`：

```ts
import type { Schemas } from "@werun/api-client";
import type { Lang } from "@werun/i18n";

/** 后台列表显示当前语言的名称；缺失时按 en → zh → km 回退，避免出现空白行 */
export function pickText(text: Schemas["LocalizedText"], lang: Lang): string {
  return text[lang] || text.en || text.zh || text.km || "";
}
```

Run: `pnpm --filter @werun/admin test src/auth src/events`
Expected: PASS，`can.test.ts` 6 个、`eventForm.test.ts` 3 个，共 `9 passed`。

- [ ] **Step 4: 写失败的应用集成测试**

`web/admin/src/test/fixtures.ts`：

```ts
import type { Schemas } from "@werun/api-client";

export const opsMe: Schemas["Me"] = {
  staff: { id: 2, username: "ops.chan", fullName: "Chanthou Ny", role: "OPS" },
  permissions: { event_config: "write", event_publish: "write", order_view: "read" },
};

export const adminMe: Schemas["Me"] = {
  staff: { id: 1, username: "admin.sovann", fullName: "Sovann Kea", role: "ADMIN" },
  permissions: { event_config: "read", event_publish: "read", access_manage: "write" },
};

export const photographerMe: Schemas["Me"] = {
  staff: { id: 9, username: "photog.sok", fullName: "Sokha Ith", role: "PHOTOGRAPHER" },
  permissions: { photo_upload: "write", photo_tag: "write" },
};

export const draftEvent: Schemas["AdminEvent"] = {
  id: 7,
  slug: "phnom-penh-half-2026",
  eventType: "RACE",
  organizerType: "OFFICIAL",
  name: { zh: "金边半程马拉松 2026", en: "Phnom Penh Half Marathon 2026", km: "ម៉ារ៉ាតុងពាក់កណ្ដាលភ្នំពេញ ២០២៦" },
  city: "Phnom Penh",
  raceDate: "2026-11-15",
  status: "DRAFT",
  publicVisible: false,
  publishedAt: null,
  categories: [
    {
      id: 11,
      code: "21K",
      name: { zh: "半程", en: "Half marathon", km: "ពាក់កណ្ដាល" },
      distanceM: 21097,
      capacity: 800,
      startAt: "2026-11-14T23:00:00Z",
      cutoffAt: "2026-11-15T02:30:00Z",
    },
  ],
};

export const unauthenticated = {
  error: { code: "UNAUTHENTICATED", message: "Please sign in" },
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

`web/admin/src/test/renderAdminApp.tsx`：

```tsx
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createAdminApp } from "../bootstrap";
import { jsonResponse } from "./fixtures";

export type MockRoutes = Record<string, (request: Request) => Response | Promise<Response>>;

/** key 形如 "GET /api/admin/me"；未声明的请求返回 404，便于发现多余的调用 */
export function renderAdminApp(path: string, routes: MockRoutes) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      const key = `${request.method} ${new URL(request.url).pathname}`;
      const handler = routes[key];
      if (!handler) {
        return jsonResponse(404, { error: { code: "NOT_FOUND", message: `no mock for ${key}` } });
      }
      return handler(request);
    }),
  );
  const app = createAdminApp({ baseUrl: "http://localhost/api", memoryPath: path });
  const view = render(app.element);
  return { ...view, router: app.router, requests };
}
```

`web/admin/src/app.test.tsx`：

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { adminMe, draftEvent, jsonResponse, opsMe, photographerMe, unauthenticated } from "./test/fixtures";
import { renderAdminApp } from "./test/renderAdminApp";

beforeEach(() => {
  window.localStorage.setItem("werun.lang", "en");
});

describe("登录", () => {
  it("未登录访问赛事列表时跳转到登录页", async () => {
    const { router } = renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(401, unauthenticated),
    });

    expect(await screen.findByTestId("login-username")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("登录成功后回到原来要访问的页面", async () => {
    let signedIn = false;
    const { router, requests } = renderAdminApp("/events", {
      "GET /api/admin/me": () => (signedIn ? jsonResponse(200, opsMe) : jsonResponse(401, unauthenticated)),
      "POST /api/admin/auth/login": () => {
        signedIn = true;
        return jsonResponse(200, opsMe);
      },
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
    });

    await userEvent.type(await screen.findByTestId("login-username"), "ops.chan");
    await userEvent.type(screen.getByTestId("login-password"), "correct-horse-battery");
    await userEvent.click(screen.getByTestId("login-submit"));

    expect(await screen.findByRole("heading", { name: "Events" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/events");
    const loginRequest = requests.find((request) => request.method === "POST");
    expect(loginRequest?.headers.get("X-WeRun-Client")).toBe("admin");
    expect(await loginRequest?.clone().json()).toEqual({ username: "ops.chan", password: "correct-horse-battery" });
  });
});

describe("权限", () => {
  it("摄影师没有赛事权限：菜单不显示赛事，直接访问显示 403", async () => {
    renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, photographerMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Events/ })).not.toBeInTheDocument();
  });

  it("ADMIN 只读：能看列表，看不到新建与发布按钮", async () => {
    renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [draftEvent] }),
    });

    expect(await screen.findByText("Phnom Penh Half Marathon 2026")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Events/ })).toBeInTheDocument();
    expect(screen.queryByTestId("event-create-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("event-publish-phnom-penh-half-2026")).not.toBeInTheDocument();
  });

  it("ADMIN 直接访问新建页显示 403", async () => {
    renderAdminApp("/events/new", {
      "GET /api/admin/me": () => jsonResponse(200, adminMe),
    });

    expect(await screen.findByTestId("forbidden-page")).toBeInTheDocument();
  });
});

describe("赛事列表", () => {
  it("OPS 发布草稿赛事后列表刷新为已发布", async () => {
    let published = false;
    const publishedEvent = { ...draftEvent, status: "PUBLISHED", publicVisible: true, publishedAt: "2026-09-14T03:00:00Z" };
    const { requests } = renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [published ? publishedEvent : draftEvent] }),
      "POST /api/admin/events/7/publish": () => {
        published = true;
        return jsonResponse(200, publishedEvent);
      },
    });

    expect(await screen.findByTestId("event-create-button")).toBeInTheDocument();
    await userEvent.click(await screen.findByTestId("event-publish-phnom-penh-half-2026"));

    await waitFor(() => {
      expect(screen.queryByTestId("event-publish-phnom-penh-half-2026")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Published")).toBeInTheDocument();
    const publishRequest = requests.find((request) => request.method === "POST");
    expect(publishRequest?.headers.get("X-WeRun-Client")).toBe("admin");
  });

  it("切换语言后页面文案与 html lang 同步", async () => {
    renderAdminApp("/events", {
      "GET /api/admin/me": () => jsonResponse(200, opsMe),
      "GET /api/admin/events": () => jsonResponse(200, { items: [] }),
    });

    await screen.findByTestId("event-create-button");
    await userEvent.click(screen.getByTestId("lang-switch-zh"));

    expect(document.documentElement.lang).toBe("zh");
    expect(await screen.findByRole("heading", { name: "赛事管理" })).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @werun/admin test src/app.test.tsx`
Expected: FAIL，`Failed to resolve import "../bootstrap"`。

- [ ] **Step 5: 实现 API 上下文、Provider 与启动函数**

`web/admin/src/api.tsx`：

```tsx
import type { ApiClient } from "@werun/api-client";
import { createContext, useContext, type ReactNode } from "react";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error("useApi 必须在 ApiProvider 内使用");
  }
  return client;
}
```

`web/admin/src/providers/AntdProvider.tsx`：

```tsx
import { useLang, type Lang } from "@werun/i18n";
import { brand } from "@werun/tokens";
import { App as AntdApp, ConfigProvider, type ConfigProviderProps } from "antd";
import enUS from "antd/locale/en_US";
import kmKH from "antd/locale/km_KH";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/km";
import "dayjs/locale/zh-cn";
import { useEffect, type ReactNode } from "react";

type AntdLocale = NonNullable<ConfigProviderProps["locale"]>;

const ANTD_LOCALES: Record<Lang, AntdLocale> = { zh: zhCN, en: enUS, km: kmKH };
const DAYJS_LOCALES: Record<Lang, string> = { zh: "zh-cn", en: "en", km: "km" };

export function AntdProvider({ children }: { children: ReactNode }) {
  const lang = useLang();

  useEffect(() => {
    dayjs.locale(DAYJS_LOCALES[lang]);
  }, [lang]);

  return (
    <ConfigProvider
      locale={ANTD_LOCALES[lang]}
      theme={{
        token: {
          colorPrimary: brand.primary,
          colorLink: brand.primary,
          borderRadius: 10,
          fontFamily: "var(--sans)",
        },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}
```

`web/admin/src/providers/AppProviders.tsx`：

```tsx
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@werun/api-client";
import type { i18n as I18n } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ApiProvider } from "../api";
import { AntdProvider } from "./AntdProvider";

interface AppProvidersProps {
  i18n: I18n;
  api: ApiClient;
  queryClient: QueryClient;
  children: ReactNode;
}

export function AppProviders({ i18n, api, queryClient, children }: AppProvidersProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiProvider client={api}>
        <QueryClientProvider client={queryClient}>
          <AntdProvider>{children}</AntdProvider>
        </QueryClientProvider>
      </ApiProvider>
    </I18nextProvider>
  );
}
```

`web/admin/src/bootstrap.tsx`（入口与测试共用，保证测试覆盖真实的 401 跳转逻辑）：

```tsx
import { QueryClient } from "@tanstack/react-query";
import { createApiClient } from "@werun/api-client";
import { currentLang, initI18n } from "@werun/i18n";
import { RouterProvider, createBrowserRouter, createMemoryRouter } from "react-router";
import { AppProviders } from "./providers/AppProviders";
import { routes } from "./routes";

type AppRouter = ReturnType<typeof createBrowserRouter>;

export interface AdminAppOptions {
  /** 默认 "/api"；测试中传绝对地址 */
  baseUrl?: string;
  /** 传入时使用内存路由（测试），否则使用浏览器路由 */
  memoryPath?: string;
}

export function createAdminApp(options: AdminAppOptions = {}) {
  const i18n = initI18n("admin");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: options.memoryPath ? false : 1 } },
  });

  let router: AppRouter | null = null;
  const api = createApiClient({
    client: "admin",
    baseUrl: options.baseUrl,
    getLang: currentLang,
    onUnauthorized: () => {
      const pathname = router?.state.location.pathname;
      if (router && pathname !== "/login") {
        void router.navigate("/login", { replace: true, state: { from: pathname } });
      }
    },
  });

  router = options.memoryPath
    ? createMemoryRouter(routes, { initialEntries: [options.memoryPath] })
    : createBrowserRouter(routes);

  const element = (
    <AppProviders i18n={i18n} api={api} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );

  return { i18n, api, queryClient, router, element };
}
```

- [ ] **Step 6: 实现登录态、权限守卫与查询**

`web/admin/src/auth/useMe.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export const ME_QUERY_KEY = ["me"] as const;

export function useMe() {
  const api = useApi();
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET("/admin/me")),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["LoginRequest"]) => unwrap(await api.POST("/admin/auth/login", { body })),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_QUERY_KEY, me);
    },
  });
}

export function useLogout() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      unwrap(await api.POST("/admin/auth/logout"));
    },
    onSettled: () => {
      queryClient.clear();
    },
  });
}
```

`web/admin/src/auth/RequireAuth.tsx`：

```tsx
import { ApiError } from "@werun/api-client";
import { Button, Result, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation } from "react-router";
import { useMe } from "./useMe";

export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  const { t } = useTranslation("common");

  if (me.isPending) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <Spin />
      </div>
    );
  }

  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return (
      <Result
        status="error"
        title={t("state.error")}
        extra={<Button onClick={() => void me.refetch()}>{t("action.retry")}</Button>}
      />
    );
  }

  return <Outlet />;
}
```

`web/admin/src/auth/RequirePermission.tsx`：

```tsx
import type { ReactNode } from "react";
import { ForbiddenPage } from "../pages/ForbiddenPage";
import { can, type Access } from "./can";
import { useMe } from "./useMe";

interface RequirePermissionProps {
  permission: string;
  access: Access;
  children: ReactNode;
}

export function RequirePermission({ permission, access, children }: RequirePermissionProps) {
  const { data: me } = useMe();
  if (!can(me?.permissions, permission, access)) {
    return <ForbiddenPage />;
  }
  return <>{children}</>;
}
```

`web/admin/src/events/queries.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@werun/api-client";
import { useApi } from "../api";

export const ADMIN_EVENTS_KEY = ["admin", "events"] as const;

export function useAdminEvents() {
  const api = useApi();
  return useQuery({
    queryKey: ADMIN_EVENTS_KEY,
    queryFn: async () => unwrap(await api.GET("/admin/events")).items,
  });
}

export function useCreateEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas["CreateEventRequest"]) => unwrap(await api.POST("/admin/events", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EVENTS_KEY }),
  });
}

export function usePublishEvent() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) =>
      unwrap(await api.POST("/admin/events/{id}/publish", { params: { path: { id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EVENTS_KEY }),
  });
}
```

- [ ] **Step 7: 实现布局与页面**

`web/admin/src/layout/LanguageSwitch.tsx`：

```tsx
import { LANGS, LANG_LABELS, setLanguage, useLang } from "@werun/i18n";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

export function LanguageSwitch() {
  const active = useLang();
  const { t } = useTranslation("common");

  return (
    <div role="group" aria-label={t("lang.label")} style={{ display: "flex", gap: 4 }}>
      {LANGS.map((lang) => (
        <Button
          key={lang}
          size="small"
          lang={lang}
          type={lang === active ? "primary" : "default"}
          aria-pressed={lang === active}
          data-testid={`lang-switch-${lang}`}
          onClick={() => void setLanguage(lang)}
        >
          {LANG_LABELS[lang]}
        </Button>
      ))}
    </div>
  );
}
```

`web/admin/src/layout/AppLayout.tsx`：

```tsx
import { CalendarOutlined, LogoutOutlined } from "@ant-design/icons";
import { Button, Layout, Menu, Space, Tag, Typography, type MenuProps } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import { PERM_EVENT_CONFIG, can, type Access } from "../auth/can";
import { useLogout, useMe } from "../auth/useMe";
import { LanguageSwitch } from "./LanguageSwitch";

interface MenuEntry {
  key: string;
  labelKey: string;
  permission: string;
  access: Access;
  icon: ReactNode;
}

/** 菜单项声明所需权限；没有权限的菜单项不渲染 */
const MENU: MenuEntry[] = [
  { key: "/events", labelKey: "events.title", permission: PERM_EVENT_CONFIG, access: "read", icon: <CalendarOutlined /> },
];

export function AppLayout() {
  const { t } = useTranslation("admin");
  const { data: me } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  const visible = MENU.filter((entry) => can(me?.permissions, entry.permission, entry.access));
  const items: MenuProps["items"] = visible.map((entry) => ({
    key: entry.key,
    icon: entry.icon,
    label: t(entry.labelKey),
  }));
  const selected = visible.find((entry) => location.pathname.startsWith(entry.key))?.key;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0} theme="light" width={220}>
        <div style={{ padding: "16px 20px", fontWeight: 800, fontSize: 18 }}>{t("common:brand.name")}</div>
        <Menu
          mode="inline"
          items={items}
          selectedKeys={selected ? [selected] : []}
          onClick={({ key }) => void navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 16,
            paddingInline: 24,
            background: "var(--card)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <LanguageSwitch />
          {me ? (
            <Space>
              <Typography.Text strong>{me.staff.fullName}</Typography.Text>
              <Tag color="blue">{t(`role.${me.staff.role}`)}</Tag>
            </Space>
          ) : null}
          <Button
            icon={<LogoutOutlined />}
            loading={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSettled: () => void navigate("/login", { replace: true }) })}
          >
            {t("layout.logout")}
          </Button>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
```

`web/admin/src/pages/ForbiddenPage.tsx`：

```tsx
import { Result } from "antd";
import { useTranslation } from "react-i18next";

export function ForbiddenPage() {
  const { t } = useTranslation("admin");
  return (
    <div data-testid="forbidden-page">
      <Result status="403" title={t("forbidden.title")} subTitle={t("forbidden.body")} />
    </div>
  );
}
```

`web/admin/src/pages/LoginPage.tsx`：

```tsx
import type { Schemas } from "@werun/api-client";
import { Alert, Button, Card, Form, Input, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useLogin } from "../auth/useMe";
import { LanguageSwitch } from "../layout/LanguageSwitch";

export function LoginPage() {
  const { t } = useTranslation("admin");
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/events";
  const required = [{ required: true, message: t("form.required") }];

  const onFinish = (values: Schemas["LoginRequest"]) => {
    login.mutate(values, {
      onSuccess: () => void navigate(from, { replace: true }),
    });
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--paper)" }}>
      <Card style={{ width: "100%", maxWidth: 380 }}>
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t("login.title")}
            </Typography.Title>
            <LanguageSwitch />
          </Space>
          {login.error ? <Alert type="error" showIcon message={login.error.message} /> : null}
          <Form<Schemas["LoginRequest"]>
            name="login"
            layout="vertical"
            requiredMark={false}
            onFinish={onFinish}
            disabled={login.isPending}
          >
            <Form.Item name="username" label={t("login.username")} rules={required}>
              <Input autoComplete="username" data-testid="login-username" />
            </Form.Item>
            <Form.Item name="password" label={t("login.password")} rules={required}>
              <Input.Password autoComplete="current-password" data-testid="login-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={login.isPending} data-testid="login-submit">
              {t("login.submit")}
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
```

`web/admin/src/pages/EventsPage.tsx`：

```tsx
import { PlusOutlined } from "@ant-design/icons";
import type { Schemas } from "@werun/api-client";
import { useLang } from "@werun/i18n";
import { Alert, App as AntdApp, Button, Space, Table, Tag, Typography, type TableProps } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { PERM_EVENT_CONFIG, PERM_EVENT_PUBLISH, can } from "../auth/can";
import { useMe } from "../auth/useMe";
import { pickText } from "../events/localize";
import { useAdminEvents, usePublishEvent } from "../events/queries";

type AdminEvent = Schemas["AdminEvent"];

export function EventsPage() {
  const { t } = useTranslation("admin");
  const lang = useLang();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { data: me } = useMe();
  const events = useAdminEvents();
  const publish = usePublishEvent();

  const canCreate = can(me?.permissions, PERM_EVENT_CONFIG, "write");
  const canPublish = can(me?.permissions, PERM_EVENT_PUBLISH, "write");

  const columns: TableProps<AdminEvent>["columns"] = [
    { title: t("events.col.name"), key: "name", render: (_, event) => pickText(event.name, lang) },
    { title: t("events.col.date"), dataIndex: "raceDate", key: "raceDate" },
    { title: t("events.col.city"), dataIndex: "city", key: "city" },
    {
      title: t("events.col.status"),
      key: "status",
      render: (_, event) => (
        <Tag color={event.status === "PUBLISHED" ? "green" : "default"}>{t(`status.${event.status}`)}</Tag>
      ),
    },
    {
      title: t("events.col.actions"),
      key: "actions",
      render: (_, event) =>
        canPublish && event.status === "DRAFT" ? (
          <Button
            size="small"
            type="primary"
            data-testid={`event-publish-${event.slug}`}
            loading={publish.isPending && publish.variables === event.id}
            onClick={() =>
              publish.mutate(event.id, {
                onSuccess: () => void message.success(t("events.publishedToast")),
                onError: (error) => void message.error(error.message),
              })
            }
          >
            {t("events.publish")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t("events.title")}
        </Typography.Title>
        {canCreate ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            data-testid="event-create-button"
            onClick={() => void navigate("/events/new")}
          >
            {t("events.create")}
          </Button>
        ) : null}
      </Space>
      {events.isError ? (
        <Alert
          type="error"
          showIcon
          message={t("common:state.error")}
          action={
            <Button size="small" onClick={() => void events.refetch()}>
              {t("common:action.retry")}
            </Button>
          }
        />
      ) : null}
      <Table<AdminEvent>
        rowKey="id"
        columns={columns}
        dataSource={events.data ?? []}
        loading={events.isPending}
        pagination={false}
        locale={{ emptyText: t("events.empty") }}
        scroll={{ x: 720 }}
      />
    </Space>
  );
}
```

`web/admin/src/pages/EventCreatePage.tsx`：

```tsx
import { PlusOutlined } from "@ant-design/icons";
import { ApiError } from "@werun/api-client";
import { App as AntdApp, Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Row, Select, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { emptyCategory, toCreateEventRequest, toNamePath, type EventFormValues } from "../events/eventForm";
import { useCreateEvent } from "../events/queries";

const NAME_LABEL_KEYS = { zh: "form.nameZh", en: "form.nameEn", km: "form.nameKm" } as const;
const NAME_LANGS = ["zh", "en", "km"] as const;

export function EventCreatePage() {
  const { t } = useTranslation("admin");
  const [form] = Form.useForm<EventFormValues>();
  const create = useCreateEvent();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const required = [{ required: true, message: t("form.required") }];

  const onFinish = (values: EventFormValues) => {
    create.mutate(toCreateEventRequest(values), {
      onSuccess: () => {
        void message.success(t("form.created"));
        void navigate("/events");
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          form.setFields(
            Object.entries(error.fields).map(([field, text]) => ({ name: toNamePath(field), errors: [text] })),
          );
        }
      },
    });
  };

  return (
    <Card title={t("form.title")}>
      {create.error ? <Alert type="error" showIcon message={create.error.message} style={{ marginBottom: 16 }} /> : null}
      <Form<EventFormValues>
        form={form}
        name="event"
        layout="vertical"
        onFinish={onFinish}
        disabled={create.isPending}
        initialValues={{ eventType: "RACE", organizerType: "OFFICIAL", categories: [emptyCategory()] }}
      >
        <Form.Item name="slug" label={t("form.slug")} extra={t("form.slugHelp")} rules={required}>
          <Input />
        </Form.Item>

        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="eventType" label={t("form.eventType")} rules={required}>
              <Select
                options={[
                  { value: "RACE", label: t("eventType.RACE") },
                  { value: "FREE_ACTIVITY", label: t("eventType.FREE_ACTIVITY") },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="organizerType" label={t("form.organizerType")} rules={required}>
              <Select
                options={[
                  { value: "OFFICIAL", label: t("organizerType.OFFICIAL") },
                  { value: "PARTNER", label: t("organizerType.PARTNER") },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>

        <Typography.Text strong>{t("form.name")}</Typography.Text>
        <Row gutter={16}>
          {NAME_LANGS.map((lang) => (
            <Col key={lang} xs={24} md={8}>
              <Form.Item name={["name", lang]} label={t(NAME_LABEL_KEYS[lang])} rules={required}>
                <Input lang={lang} />
              </Form.Item>
            </Col>
          ))}
        </Row>

        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="city" label={t("form.city")} rules={required}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="raceDate" label={t("form.raceDate")} rules={required}>
              <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>

        <Typography.Title level={5}>{t("form.categories")}</Typography.Title>
        <Form.List name="categories">
          {(fields, { add, remove }) => (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              {fields.map((field) => (
                <Card
                  key={field.key}
                  size="small"
                  extra={
                    <Button type="link" danger onClick={() => remove(field.name)}>
                      {t("form.removeCategory")}
                    </Button>
                  }
                >
                  <Row gutter={16}>
                    <Col xs={24} md={6}>
                      <Form.Item name={[field.name, "code"]} label={t("form.categoryCode")} rules={required}>
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={9}>
                      <Form.Item name={[field.name, "distanceM"]} label={t("form.distanceM")} rules={required}>
                        <InputNumber min={1} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={9}>
                      <Form.Item name={[field.name, "capacity"]} label={t("form.capacity")} rules={required}>
                        <InputNumber min={1} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={16}>
                    {NAME_LANGS.map((lang) => (
                      <Col key={lang} xs={24} md={8}>
                        <Form.Item
                          name={[field.name, "name", lang]}
                          label={`${t("form.categoryName")} · ${t(NAME_LABEL_KEYS[lang])}`}
                          rules={required}
                        >
                          <Input lang={lang} />
                        </Form.Item>
                      </Col>
                    ))}
                  </Row>
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Form.Item name={[field.name, "startAt"]} label={t("form.startAt")}>
                        <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name={[field.name, "cutoffAt"]} label={t("form.cutoffAt")}>
                        <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>
              ))}
              <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add(emptyCategory())}>
                {t("form.addCategory")}
              </Button>
            </Space>
          )}
        </Form.List>

        <Space style={{ marginTop: 24 }}>
          <Button onClick={() => void navigate("/events")}>{t("common:action.back")}</Button>
          <Button type="primary" htmlType="submit" loading={create.isPending} data-testid="event-form-submit">
            {t("form.submit")}
          </Button>
        </Space>
      </Form>
    </Card>
  );
}
```

`web/admin/src/routes.tsx`：

```tsx
import { Navigate, type RouteObject } from "react-router";
import { PERM_EVENT_CONFIG } from "./auth/can";
import { RequireAuth } from "./auth/RequireAuth";
import { RequirePermission } from "./auth/RequirePermission";
import { AppLayout } from "./layout/AppLayout";
import { EventCreatePage } from "./pages/EventCreatePage";
import { EventsPage } from "./pages/EventsPage";
import { LoginPage } from "./pages/LoginPage";

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/events" replace /> },
          {
            path: "events",
            element: (
              <RequirePermission permission={PERM_EVENT_CONFIG} access="read">
                <EventsPage />
              </RequirePermission>
            ),
          },
          {
            path: "events/new",
            element: (
              <RequirePermission permission={PERM_EVENT_CONFIG} access="write">
                <EventCreatePage />
              </RequirePermission>
            ),
          },
          { path: "*", element: <Navigate to="/events" replace /> },
        ],
      },
    ],
  },
];
```

`web/admin/src/main.tsx`：

```tsx
import "@ant-design/v5-patch-for-react-19";
import "@werun/tokens/tokens.css";
import "@werun/tokens/fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAdminApp } from "./bootstrap";

const app = createAdminApp();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html 缺少 #root 节点");
}

createRoot(rootElement).render(<StrictMode>{app.element}</StrictMode>);
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm --filter @werun/admin test`
Expected: PASS，`can.test.ts` 6 个、`eventForm.test.ts` 3 个、`app.test.tsx` 6 个，共 `15 passed`。控制台不应出现 `antd v5 support React is 16 ~ 18` 警告。

- [ ] **Step 9: 全量验证前端**

Run: `pnpm --filter @werun/admin build && pnpm lint && make test-web`
Expected: `vite build` 输出 `web/admin/dist/index.html` 与 `dist/assets/*`，退出码 0；lint 无错误；`make test-web` 中四个前端包测试全部通过、`i18n 检查通过`。

- [ ] **Step 10: 提交**

```bash
git add web/admin pnpm-lock.yaml
git commit -F - <<'EOF'
feat(admin): add admin app with login, permission guards and events management

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsngKX547da5HwP76FAB8Y
EOF
```
