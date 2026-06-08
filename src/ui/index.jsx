import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initClient } from './api/client.js';
import App from './App.jsx';
import OnboardingView from './views/Onboarding.jsx';
import './index.css';

const root = createRoot(document.getElementById('root'));

async function launchApp() {
  const apiUrl = window.flashback
    ? await window.flashback.getApiUrl()
    : 'http://localhost:50500';
  initClient(apiUrl);
  root.render(
    <StrictMode>
      <App />
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
