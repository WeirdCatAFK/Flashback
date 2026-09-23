/**
 * The renderer entry: first-run detection, API client initialisation for the
 * active connection, the providers (translations, confirm), and the App or the
 * Setup wizard.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initClient } from "./api/client.js";
import { setActiveVaultScope } from "./prefs.js";
import App from "./App.jsx";
import SetupView from "./views/setup/Setup.jsx";
import { ConfirmProvider } from "./components/base/ConfirmDialog.jsx";
import { TranslationProvider } from "./translations/components.jsx";
import "@fontsource/didact-gothic/400.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/700.css";
import "@fontsource/noto-sans/400.css";
import "@fontsource/noto-sans/500.css";
import "@fontsource/noto-sans/600.css";
import "@fontsource/noto-sans/700.css";
import "./index.css";
import "./components/base/base.css";

const root = createRoot(document.getElementById("root"));

/**
 * Forward uncaught renderer errors into the main-process log file so front-end
 * crashes aren't lost in packaged builds (no-op in the browser-only dev fallback).
 */
if (window.flashback?.logRendererError) {
  window.addEventListener("error", (event) => {
    window.flashback.logRendererError(
      event.error?.stack ||
        `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    window.flashback.logRendererError(reason?.stack || String(reason));
  });
}

async function launchApp() {
  const connection = window.flashback?.getActiveConnection
    ? await window.flashback.getActiveConnection()
    : null;

  const apiUrl =
    connection?.url ??
    (window.flashback
      ? await window.flashback.getApiUrl()
      : "http://localhost:50500");
  const apiToken =
    connection?.token ??
    (window.flashback
      ? await window.flashback.getApiToken()
      : (import.meta.env?.VITE_FLASHBACK_API_TOKEN ?? null));
  initClient(apiUrl, apiToken);
  setActiveVaultScope(connection?.id ?? null);
  root.render(
    <StrictMode>
      <TranslationProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </TranslationProvider>
    </StrictMode>,
  );
}

async function bootstrap() {
  if (window.flashback && (await window.flashback.isFirstRun())) {
    root.render(
      <StrictMode>
        <TranslationProvider>
          <SetupView onComplete={launchApp} />
        </TranslationProvider>
      </StrictMode>,
    );
    return;
  }
  await launchApp();
}

bootstrap();
