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
