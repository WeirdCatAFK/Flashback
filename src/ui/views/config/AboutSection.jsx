/**
 * AboutSection — the installed version, updates (check, then Update now, then Restart
 * and install, each step saying where it stands), and the welcome tour. The update state
 * is useAppUpdates.js, held by Config.
 */

import { useT } from '../../translations/index';
import ConfigRow from './ConfigRow';

function UpdateLine({ updates }) {
  const { t } = useT();
  const { status, busy } = updates;
  switch (status.state) {
    case 'available':
      return (
        <>
          <span className="cf-accent">{t('Version {version} is available.', { version: status.version })}</span>
          <button type="button" className="btn btn--quiet-accent btn--sm" onClick={updates.download} disabled={busy}>{t('Update now')}</button>
        </>
      );
    case 'downloading':
      return (
        <>
          <span className="cf-dim">{t('Downloading… {percent}%', { percent: status.percent ?? 0 })}</span>
          <span className="cf-dl" aria-hidden="true"><i style={{ width: `${status.percent ?? 0}%` }} /></span>
        </>
      );
    case 'downloaded':
      return (
        <>
          <span className="cf-accent">{t('Version {version} is ready to install.', { version: status.version })}</span>
          <button type="button" className="btn btn--quiet-accent btn--sm" onClick={updates.install}>{t('Restart and install')}</button>
        </>
      );
    case 'none': return <span className="cf-dim">{t('You’re up to date.')}</span>;
    case 'dev': return <span className="cf-dim">{t('Updates are only available in the packaged app.')}</span>;
    case 'error': return <span className="cf-error">{status.message || t('Update check failed.')}</span>;
    default: return null;
  }
}

export default function AboutSection({ desktop, updates, onReplayTour }) {
  const { t } = useT();
  const { status, busy } = updates;
  return (
    <>
      {desktop && (
        <>
          <ConfigRow id="version">
            <span className="cf-static">{updates.version ? `v${updates.version}` : '—'}</span>
          </ConfigRow>
          <ConfigRow id="updates">
            <span className="cf-update">
              <button type="button" className="btn btn--quiet btn--sm" onClick={updates.check}
                disabled={busy || status.state === 'checking' || status.state === 'downloading'}>
                {status.state === 'checking' ? t('Checking…') : t('Check for updates')}
              </button>
              <UpdateLine updates={updates} />
            </span>
          </ConfigRow>
        </>
      )}
      {onReplayTour && (
        <ConfigRow id="tour">
          <button type="button" className="btn btn--quiet btn--sm" onClick={onReplayTour}>{t('Replay the tour')}</button>
        </ConfigRow>
      )}
    </>
  );
}
