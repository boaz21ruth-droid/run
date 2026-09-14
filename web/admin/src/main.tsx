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
