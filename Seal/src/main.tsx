import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./shared/styles/global.css";
import "./shared/styles/components.css";
import "./styles/layout.css";

// Surface unhandled errors in release builds where devtools may not be open
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("Uncaught error:", e.error || e.message);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
