import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initClient } from './api/client.js';
import App from './App.jsx';
import './index.css';

async function bootstrap() {
  // In Electron, ask main for the API URL via IPC.
  // In dev:web mode (no Electron), fall back to the default port. (maybve in the future I should change this to actually check if its in devmode)
  const apiUrl = window.flashback
    ? await window.flashback.getApiUrl()
    : 'http://localhost:50500';

  initClient(apiUrl);

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

bootstrap();
