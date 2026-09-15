import "@werun/tokens/tokens.css";
import "@werun/tokens/fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { createUserApp } from "./bootstrap";
import { routes } from "./routes";
import { initTelegram } from "./telegram/telegram";

const router = createBrowserRouter(routes);
const app = createUserApp({ router });

initTelegram(router).catch((error: unknown) => {
  // SDK 加载失败不影响网页本身可用
  console.error(error);
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("index.html 缺少 #root 节点");
}

createRoot(rootElement).render(<StrictMode>{app.element}</StrictMode>);
