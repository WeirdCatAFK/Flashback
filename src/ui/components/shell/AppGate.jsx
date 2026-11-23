import { useEffect, useRef, useState } from 'react';
import { pingApi } from '../../api/client';
import { useT } from '../../translations/index';
import './AppGate.css';

const POLL_INTERVAL_MS = 400;
const SLOW_THRESHOLD_MS = 10000;

export default function AppGate({ children }) {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const startRef = useRef(null);
  if (startRef.current === null) startRef.current = Date.now();

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
      <div className="app-gate-inner" role="status">
        <p className="app-gate-title">{t('Starting Flashback…')}</p>
        <span className="app-gate-line" aria-hidden="true"><i /></span>
        {slow && (
          <div className="app-gate-slow">
            <p className="app-gate-slow-text">{t('The workspace service is taking a while to start.')}</p>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setAttempt(a => a + 1)}>
              {t('Retry now')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
