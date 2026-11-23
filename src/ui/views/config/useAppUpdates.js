import { useState, useEffect } from 'react';
import { getAppVersion, onUpdateStatus, checkForUpdates, downloadUpdate, installUpdate, isDesktop } from '../../api/desktop';

export default function useAppUpdates() {
  const [version, setVersion] = useState(null);
  const [status, setStatus] = useState({ state: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return undefined;
    getAppVersion().then(setVersion).catch(() => {});
    return onUpdateStatus((s) => setStatus(s));
  }, []);

  const check = async () => {
    setBusy(true);
    setStatus({ state: 'checking' });
    const r = await checkForUpdates();
    setBusy(false);
    if (!r.ok) setStatus({ state: r.dev ? 'dev' : 'error', message: r.error });
    else if (!r.version) setStatus({ state: 'none' });
  };

  const download = async () => {
    setBusy(true);
    const r = await downloadUpdate();
    setBusy(false);
    if (!r.ok) setStatus({ state: 'error', message: r.error });
  };

  return {
    version, status, busy, check, download, install: installUpdate,
    waiting: status.state === 'available' || status.state === 'downloaded',
  };
}
