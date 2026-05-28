import { useEffect, useRef, useState } from 'react';
import { pingApi } from '../api/client';
import './AppGate.css';

// Blocks the app until the API process answers. In Electron the renderer mounts
// the instant the window opens, but the API runs in a separate process that may
// still be validating/listening — so the first reads would race it and fail.
// Rendering the workspace before reads succeed risks writing an empty document
// back over real files (see the empty-workspace data-loss bug), so we gate here.
const POLL_INTERVAL_MS = 400;
const SLOW_THRESHOLD_MS = 10000; // after this, surface a manual retry

export default function AppGate({ children }) {
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumping this re-runs the poll
  const startRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    startRef.current = Date.now();
    setSlow(false);

    const poll = async () => {
      if (cancelled) return;
      if (await pingApi()) {
        if (!cancelled) setReady(true);
        return;
      }
      if (cancelled) return;
      if (Date.now() - startRef.current >= SLOW_THRESHOLD_MS) setSlow(true);
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [attempt]);

  if (ready) return children;

  return (
    <div className="app-gate">
      <div className="app-gate-inner">
        <div className="app-gate-spinner" />
        <p className="app-gate-title">Starting Flashback…</p>
        {slow && (
          <div className="app-gate-slow">
            <p className="app-gate-slow-text">The workspace service is taking a while to start.</p>
            <button className="app-gate-retry" onClick={() => setAttempt(a => a + 1)}>
              Retry now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
