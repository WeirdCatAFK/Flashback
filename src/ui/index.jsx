import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initClient } from './api/client.js';
import App from './App.jsx';
import OnboardingView from './views/Onboarding.jsx';
import { ConfirmProvider } from './components/shared/ConfirmDialog.jsx';
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
  const apiUrl = window.flashback
    ? await window.flashback.getApiUrl()
    : 'http://localhost:50500';
  // Electron hands the token over IPC. In the browser-only dev fallback there is
  // no IPC; a token can be supplied via VITE_FLASHBACK_API_TOKEN, otherwise none
  // is sent (the standalone dev API leaves auth disabled).
  const apiToken = window.flashback
    ? await window.flashback.getApiToken()
    : (import.meta.env?.VITE_FLASHBACK_API_TOKEN ?? null);
  initClient(apiUrl, apiToken);
  root.render(
    <StrictMode>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </StrictMode>
  );
}

async function bootstrap() {
  if (window.flashback && await window.flashback.isFirstRun()) {
    root.render(
      <StrictMode>
        <OnboardingView onComplete={launchApp} />
      </StrictMode>
    );
    return;
  }
  await launchApp();
}

bootstrap();
