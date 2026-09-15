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
    // 兜底：`pnpm test` 多个工作区并行时 CPU 争用会拖慢多步表单用例，vitest 默认 5 秒超时过紧
    testTimeout: 15_000,
  },
});
