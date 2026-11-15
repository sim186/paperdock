import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/roboto-flex/full.css";
import "material-symbols/rounded.css";
import App from "./App";

async function start() {
  // `npm run dev` in a plain browser: fake the Rust backend so the UI can be worked on.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mockBackend");
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start();
