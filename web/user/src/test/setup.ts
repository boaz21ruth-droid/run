import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

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
