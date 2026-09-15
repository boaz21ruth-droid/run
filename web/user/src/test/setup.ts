import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// CI 机器核数少，页面首屏渲染可能超过 findBy* 默认的 1 秒
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete window.Telegram;
  // resolveInitData 可能插入 Telegram SDK 的 script，清掉以免下一个用例复用已触发过 load 的元素
  document.head.querySelectorAll("script").forEach((script) => script.remove());
  window.history.replaceState(null, "", "/");
});
