import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isBridgeInstalled } from "./app/api-client";
import { RendererRoot } from "./app/RendererRoot";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Interleaf renderer: #root container missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <RendererRoot bridgeInstalled={isBridgeInstalled()} />
  </StrictMode>,
);
