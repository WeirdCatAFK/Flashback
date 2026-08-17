import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initClient } from './api/client.js';
import { setActiveVaultScope } from './prefs.js';
import App from './App.jsx';
import SetupView from './views/Setup.jsx';
import { ConfirmProvider } from './components/shared/ConfirmDialog.jsx';
import { TranslationProvider } from './translations/index.jsx';
import './index.css';

const root = createRoot(document.getElementById('root'));

// Forward uncaught renderer errors into the main-process log file so front-end
// crashes aren't lost in packaged builds (no-op in the browser-only dev fallback).
if (window.flashback?.logRendererError) {
  window.addEventListener('error', (event) => {
    window.flashback.logRendererError(
      event.error?.stack || `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.flashback.logRendererError(reason?.stack || String(reason));
  });
}

async function launchApp() {
  // One call describes whatever the app should be pointed at — the local API serving the
  // active local vault, or a remote Flashback Server the user was last working on. Both
  // are a {url, token} pair, so the client is initialised the same way either way.
  // getApiUrl/getApiToken remain for older callers but are no longer the bootstrap path.
  const connection = window.flashback?.getActiveConnection
    ? await window.flashback.getActiveConnection()
    : null;

  const apiUrl = connection?.url
    ?? (window.flashback ? await window.flashback.getApiUrl() : 'http://localhost:50500');
  // Electron hands the token over IPC. In the browser-only dev fallback there is
  // no IPC; a token can be supplied via VITE_FLASHBACK_API_TOKEN, otherwise none
  // is sent (the standalone dev API leaves auth disabled).
  const apiToken = connection?.token
    ?? (window.flashback
      ? await window.flashback.getApiToken()
      : (import.meta.env?.VITE_FLASHBACK_API_TOKEN ?? null));
  initClient(apiUrl, apiToken);
  // Study preferences are stored per vault; tell the prefs layer which one is active
  // before any view reads a setting.
  setActiveVaultScope(connection?.id ?? null);
  root.render(
    <StrictMode>
      <TranslationProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </TranslationProvider>
    </StrictMode>
  );
}

async function bootstrap() {
  if (window.flashback && await window.flashback.isFirstRun()) {
    root.render(
      <StrictMode>
        <TranslationProvider>
          <SetupView onComplete={launchApp} />
        </TranslationProvider>
      </StrictMode>
    );
    return;
  }
  await launchApp();
}

bootstrap();
