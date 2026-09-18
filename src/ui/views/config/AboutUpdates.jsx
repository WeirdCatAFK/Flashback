/**
 * AboutUpdates — the installed version and the notify-first update flow
 * (check → download → install), driven by the update-status IPC stream.
 */

import { useState, useEffect } from 'react';
import { getAppVersion, onUpdateStatus, checkForUpdates, downloadUpdate, installUpdate, isDesktop } from '../../api/desktop';
import { useT } from '../../translations/index';

function UpdateStatusLine({ status, onDownload, onInstall, busy }) {
  const { t } = useT();
  switch (status.state) {
    case 'available':
      return (
        <span className="config-update-notice">
          {t('Version {version} is available.', { version: status.version })}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onDownload}
            disabled={busy}
          >
            {t('Update now')}
          </button>
        </span>
      );
    case 'downloading':
      return <span className="config-status">{t('Downloading… {percent}%', { percent: status.percent ?? 0 })}</span>;
    case 'downloaded':
      return (
        <span className="config-update-notice">
          {t('Version {version} is ready to install.', { version: status.version })}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onInstall}
          >
            {t('Restart & install')}
          </button>
        </span>
      );
    case 'none':
      return <span className="config-status">{t('You’re up to date.')}</span>;
    case 'dev':
      return <span className="config-hint">{t('Updates are only available in the packaged app.')}</span>;
    case 'error':
      return (
        <span className="config-status config-status--error">
          {status.message || t('Update check failed.')}
        </span>
      );
    default:
      return null;
  }
}

export default function AboutUpdates() {
  const { t } = useT();
  const [version, setVersion] = useState(null);
  const [status, setStatus] = useState({ state: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return undefined;
    getAppVersion().then(setVersion).catch(() => {});
    return onUpdateStatus((s) => setStatus(s));
  }, []);

  const handleCheck = async () => {
    setBusy(true);
    setStatus({ state: 'checking' });
    const r = await checkForUpdates();
    setBusy(false);
    if (!r.ok) setStatus({ state: r.dev ? 'dev' : 'error', message: r.error });
    else if (!r.version) setStatus({ state: 'none' });
  };

  const handleDownload = async () => {
    setBusy(true);
    const r = await downloadUpdate();
    setBusy(false);
    if (!r.ok) setStatus({ state: 'error', message: r.error });
  };

  const handleInstall = () => installUpdate();

  if (!isDesktop()) {
    return <p className="config-hint">{t('Version and updates are available in the desktop app.')}</p>;
  }

  return (
    <div className="config-about">
      <table className="config-table">
        <tbody>
          <tr>
            <td><label>{t('Version')}</label></td>
            <td><span className="config-version">{version ? `v${version}` : '—'}</span></td>
          </tr>
        </tbody>
      </table>

      <div className="config-update-row">
        <button
          type="button"
          className="btn btn--sm"
          onClick={handleCheck}
          disabled={busy || status.state === 'checking' || status.state === 'downloading'}
        >
          {status.state === 'checking' ? t('Checking…') : t('Check for updates')}
        </button>
        <UpdateStatusLine
          status={status}
          onDownload={handleDownload}
          onInstall={handleInstall}
          busy={busy}
        />
      </div>
    </div>
  );
}
