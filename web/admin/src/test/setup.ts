import "@ant-design/v5-patch-for-react-19";
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// CI 机器核数少，antd 页面在 jsdom 中首屏渲染可能超过 findBy* 默认的 1 秒
configure({ asyncUtilTimeout: 5_000 });

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
