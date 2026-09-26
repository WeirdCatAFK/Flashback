/**
 * ServerSection — the local API this app and an AI assistant talk to (config.json, through
 * useConfig.js). The one section with a Save: its fields change what the server listens
 * on, so they wait to be saved and apply after a restart. A bar at the foot says what is
 * pending, and after a save offers the restart.
 */

import { restartApp } from '../../api/desktop';
import { useT } from '../../translations/index';
import ConfigRow from './ConfigRow';
import { useSearching } from './rowsContext.js';

const LOG_FORMATS = ['dev', 'combined', 'tiny', 'short'];

export default function ServerSection({ cfg }) {
  const { t } = useT();
  const searching = useSearching();
  const { form, isDirty, status, restartPending } = cfg;
  if (!form) return null;
  const failed = status && status !== 'saved' && status !== 'saving' ? status.replace(/^error: /, '') : null;

  return (
    <>
      {!searching && <p className="cf-lede">{t('The API this app and your AI assistant talk to. Most people never change it.')}</p>}
      <ConfigRow id="vault">
        <span className="cf-static">{form.vaultName ?? t('default')}</span>
      </ConfigRow>
      <ConfigRow id="port" htmlFor="cf-port" restart>
        <input id="cf-port" className="field field--sm cf-in cf-num" type="number" value={form.port ?? 50500}
          onChange={(e) => cfg.change('port', Number(e.target.value))} />
      </ConfigRow>
      <ConfigRow id="host" htmlFor="cf-host" restart>
        <input id="cf-host" className="field field--sm cf-in" value={form.host ?? 'localhost'} onChange={(e) => cfg.change('host', e.target.value)} />
      </ConfigRow>
      <ConfigRow id="logFormat" htmlFor="cf-log" restart>
        <select id="cf-log" className="field field--sm cf-select" value={form.logFormat ?? 'dev'} onChange={(e) => cfg.change('logFormat', e.target.value)}>
          {LOG_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </ConfigRow>
      {form.isCustomPath && (
        <ConfigRow id="workspacePath">
          <span className="cf-static">{form.customPath || '—'}</span>
        </ConfigRow>
      )}

      {(isDirty || restartPending || failed) && (
        <div className="cf-bar" role="status">
          {restartPending && !isDirty ? (
            <>
              <span className="cf-bar__text">{t('Saved. The server uses the new settings after a restart.')}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={cfg.dismissRestart}>{t('Later')}</button>
              <button type="button" className="btn btn--quiet-accent btn--sm" onClick={restartApp}>{t('Restart now')}</button>
            </>
          ) : (
            <>
              <span className="cf-bar__dot" aria-hidden="true" />
              <span className="cf-bar__text">
                {failed ?? (cfg.hasRestartDirty ? t('Unsaved changes, applied after a restart.') : t('Unsaved changes.'))}
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={cfg.discard} disabled={status === 'saving'}>{t('Discard')}</button>
              <button type="button" className="btn btn--quiet-accent btn--sm" onClick={cfg.save} disabled={!isDirty || status === 'saving'}>
                {status === 'saving' ? t('Saving…') : t('Save')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
