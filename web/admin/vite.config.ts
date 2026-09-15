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
    // antd 组件在 jsdom 中渲染较慢；CI 4 核上 13 个页面测试文件并行，填 14 个字段的新建赛事用例约 16 秒
    testTimeout: 30_000,
  },
});
