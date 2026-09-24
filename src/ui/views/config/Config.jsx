/**
 * Config — the settings view: server config (needs Save, some fields a
 * restart), study preferences, appearance and the theme editor, keybindings,
 * identity, the diary, the AI assistant, and About. Hooks: useConfig (the
 * config.json form), useSrsPrefs / useDiaryPref (vault-scoped preferences).
 */

import { useState } from 'react';
import KeybindingsEditor from '../../components/shell/KeybindingsEditor';
import IdentitySection from '../../components/account/IdentitySection';
import ProgressDialog from '../../components/base/ProgressDialog';
import Toggle from '../../components/base/Toggle';
import { treeIconsOn, setTreeIcons } from '../../treeIcons.js';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import { migrateProgress } from '../../api/srs';
import { restartApp } from '../../api/desktop';
import { useT } from '../../translations/index';
import { LanguagePicker, Rich } from '../../translations/components.jsx';
import { loadCustomThemes } from '../../customThemes';
import { themeLabel } from '../../themes';
import { diaryLabels, isSharedVault } from '../../diaryLabels.js';
import useConfig from './useConfig';
import useSrsPrefs, { useDiaryPref } from './useSrsPrefs';
import ThemeEditor from './ThemeEditor';
import McpIntegration from './McpIntegration';
import AboutUpdates from './AboutUpdates';
import FsrsOptimizer from './FsrsOptimizer';
import './Config.css';

/** Display name for an algorithm id. */
const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };
const algoLabel = (a) => ALGO_LABEL[a] ?? a;

export default function ConfigView({
  theme,
  onThemeChange,
  allThemes,
  onCustomThemesChange,
  onReplayTour,
  connection,
}) {
  const { t } = useT();
  const cfg = useConfig();
  const { form, loading, error, status, restartPending, isDirty, hasRestartDirty } = cfg;
  const handleChange = cfg.change;
  const handleSave = cfg.save;
  const setDiaryAccess = (mode) => cfg.writeField('mcpDiaryAccess', mode);
  const { algorithm, applyAlgorithm, maxNew, setMaxNew, retention, setRetention, order, setOrder } = useSrsPrefs();
  const { enabled: diaryEnabled, setEnabled: setDiaryEnabled } = useDiaryPref();
  const studyRecord = diaryLabels(t, isSharedVault(connection));

  const [pendingAlgo, setPendingAlgo] = useState(null);
  const [migrating, setMigrating] = useState(false);
  const [treeIcons, setTreeIconsState] = useState(treeIconsOn);

  const handleAlgorithmSelect = (next) => {
    if (next === algorithm) return;
    setPendingAlgo(next);
  };

  const confirmMigrate = async (carryOver) => {
    const from = algorithm;
    const to = pendingAlgo;
    setPendingAlgo(null);
    if (carryOver) {
      setMigrating(true);
      try {
        await migrateProgress(from, to);
      } catch { }
      setMigrating(false);
    }
    applyAlgorithm(to);
  };

  const cancelAlgorithmChange = () => setPendingAlgo(null);

  const diaryAccess =
    form?.mcpDiaryAccess === true || form?.mcpDiaryAccess === 'full'
      ? 'full'
      : form?.mcpDiaryAccess === 'summaries'
        ? 'summaries'
        : 'none';

  const handleThemeEditorSaved = () => {
    onCustomThemesChange(loadCustomThemes());
  };

  return (
    <div className="config-view">
      <section className="config-section">
        <h2 className="eyebrow config-heading">{t('Appearance')}</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label htmlFor="locale-select">{t('Language')}</label>
              </td>
              <td>
                <LanguagePicker id="locale-select" />
              </td>
            </tr>
            <tr>
              <td>
                <label htmlFor="theme-select">{t('Theme')}</label>
              </td>
              <td>
                <select
                  id="theme-select"
                  value={theme ?? "light-workbench"}
                  onChange={(e) => onThemeChange(e.target.value)}
                >
                  {allThemes.map((name) => (
                    <option key={name} value={name}>
                      {themeLabel(t, name)}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <td>{t('File tree')}</td>
              <td>
                <Toggle checked={treeIcons} onChange={(on) => { setTreeIcons(on); setTreeIconsState(on); }} label={t('Icons in the file tree')} />
              </td>
            </tr>
          </tbody>
        </table>
        <div className="config-collapsibles">
          <ThemeEditor
            onSaved={handleThemeEditorSaved}
            onThemeChange={onThemeChange}
            currentTheme={theme}
          />
          <KeybindingsEditor />
        </div>
      </section>

      <section className="config-section">
        <h2 className="eyebrow config-heading">{t('Flashcards')}</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label htmlFor="srs-algorithm">{t('SRS algorithm')}</label>
              </td>
              <td>
                <select
                  id="srs-algorithm"
                  value={pendingAlgo ?? algorithm}
                  onChange={(e) => handleAlgorithmSelect(e.target.value)}
                >
                  <option value="leitner">{t('Leitner (doubles each level)')}</option>
                  <option value="sm2">{t('SM-2 (ease factor)')}</option>
                  <option value="fsrs">{t('FSRS (memory model)')}</option>
                </select>
              </td>
            </tr>
            {pendingAlgo && (
              <tr>
                <td colSpan={2}>
                  <div className="algo-migrate-confirm">
                    <p className="algo-migrate-msg">
                      <Rich
                        text={t('Switch to {algorithm}?')}
                        values={{ algorithm: <strong>{algoLabel(pendingAlgo)}</strong> }}
                      />
                    </p>
                    <div className="algo-migrate-actions">
                      <button type="button" className="btn btn--primary btn--sm"
                        onClick={() => confirmMigrate(true)}>
                        {t('Carry over progress')}
                      </button>
                      <button type="button" className="btn btn--sm"
                        onClick={() => confirmMigrate(false)}>
                        {t('Start fresh')}
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm"
                        onClick={cancelAlgorithmChange}>
                        {t('Cancel')}
                      </button>
                    </div>
                    <p className="algo-migrate-hint">
                      {t('Carry over maps each card’s current interval to the nearest equivalent in {algorithm}.',
                        { algorithm: algoLabel(pendingAlgo) })}
                    </p>
                  </div>
                </td>
              </tr>
            )}
            {algorithm === 'fsrs' && (
              <tr>
                <td>
                  <label htmlFor="fsrs-retention">{t('Desired retention')}</label>
                </td>
                <td>
                  <div className="fsrs-retention-row">
                    <input
                      id="fsrs-retention"
                      type="range"
                      min={0.7}
                      max={0.97}
                      step={0.01}
                      value={retention}
                      onChange={(e) => setRetention(e.target.value)}
                    />
                    <span className="fsrs-retention-value">{Math.round(retention * 100)}%</span>
                  </div>
                  <p className="config-hint">
                    {t('Higher = more frequent reviews and stronger recall; lower = fewer reviews. 90% is a good default.')}
                  </p>
                </td>
              </tr>
            )}
            {algorithm === 'fsrs' && (
              <tr>
                <td>
                  <label>{t('Optimize parameters')}</label>
                </td>
                <td>
                  <FsrsOptimizer />
                </td>
              </tr>
            )}
            <tr>
              <td>
                <label htmlFor="trainer-order">{t('Card order')}</label>
              </td>
              <td>
                <select
                  id="trainer-order"
                  value={order}
                  onChange={(e) => setOrder(e.target.value)}
                >
                  <option value="interleaved">{t('Interleaved (spreads related cards apart)')}</option>
                  <option value="shuffle">{t('Shuffled (random)')}</option>
                  <option value="priority">{t('By category priority')}</option>
                </select>
                <p className="config-hint">
                  {order === 'interleaved' && t('Cards from the same document, tag or folder are spread apart so each one is recalled on its own.')}
                  {order === 'shuffle' && t('Random order within each category-priority tier.')}
                  {order === 'priority' && t('Foundational cards first, then in the order they were created.')}
                </p>
              </td>
            </tr>
            <tr>
              <td>
                <label htmlFor="srs-max-new">{t('New cards per day')}</label>
              </td>
              <td>
                <input
                  id="srs-max-new"
                  aria-label={t('New cards per day')}
                  type="number"
                  min={0}
                  max={200}
                  value={maxNew}
                  onChange={(e) => setMaxNew(e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="config-section">
        <h2 className="eyebrow config-heading">{studyRecord.title}</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label>{studyRecord.prefLabel}</label>
              </td>
              <td>
                <Toggle checked={diaryEnabled} onChange={setDiaryEnabled} label={t('Record a daily summary when a study session finishes')} />
                <p className="config-hint">{studyRecord.prefHint}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {onReplayTour && (
        <section className="config-section">
          <h2 className="eyebrow config-heading">{t('Getting started')}</h2>
          <p className="config-hint">
            {t('Take the guided tour of Flashback’s features again.')}
          </p>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onReplayTour}
          >
            {t('Replay welcome tour')}
          </button>
        </section>
      )}

      {loading && <LoadingState message={t('Loading settings…')} />}
      {error && <ErrorState error={error} title={t("Couldn't load settings")} />}

      {form && (
        <>
          <IdentitySection connection={connection} />

          <section className="config-section">
            <h2 className="eyebrow config-heading">{t('Server')}</h2>
            <table className="config-table">
              <tbody>
                <tr>
                  <td>{t('Active vault')}</td>
                  <td>
                    <span className="config-static-value">{form.vaultName ?? t('default')}</span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <label htmlFor="cfg-port">{t('Port')}</label>
                  </td>
                  <td>
                    <input
                      id="cfg-port"
                      aria-label={t('Port')}
                      type="number"
                      value={form.port ?? 50500}
                      onChange={(e) =>
                        handleChange("port", Number(e.target.value))
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label htmlFor="cfg-host">{t('Host')}</label>
                  </td>
                  <td>
                    <input
                      id="cfg-host"
                      aria-label={t('Host')}
                      value={form.host ?? "localhost"}
                      onChange={(e) => handleChange("host", e.target.value)}
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label htmlFor="cfg-log-format">{t('Log format')}</label>
                  </td>
                  <td>
                    <select
                      id="cfg-log-format"
                      value={form.logFormat ?? "dev"}
                      onChange={(e) => handleChange("logFormat", e.target.value)}
                    >
                      <option value="dev">dev</option>
                      <option value="combined">combined</option>
                      <option value="tiny">tiny</option>
                      <option value="short">short</option>
                    </select>
                  </td>
                </tr>
                {form.isCustomPath && (
                  <tr>
                    <td>{t('Workspace path')}</td>
                    <td>
                      <span className="config-static-value">{form.customPath || '—'}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="config-save-row">
              <button
                type="button"
                className={`btn${isDirty ? ' btn--primary' : ''}`}
                onClick={handleSave}
                disabled={!isDirty || status === 'saving'}
              >
                {status === 'saving' ? t('Saving…') : status === 'saved' ? t('✓ Saved') : t('Save changes')}
              </button>
              {isDirty && (
                <span className="config-unsaved-indicator">
                  <span className="config-unsaved-dot" />
                  {t('Unsaved changes')}
                </span>
              )}
              {status && status !== 'saved' && status !== 'saving' && (
                <span className="config-status config-status--error">
                  {status.replace(/^error: /, '')}
                </span>
              )}
            </div>

            {hasRestartDirty && (
              <p className="config-hint">
                {t('⚠ Changes to vault name, port, host, log format, or workspace path require a restart to take effect.')}
              </p>
            )}

            {restartPending && (
              <div className="config-restart-prompt">
                <span className="config-restart-message">
                  {t('Server settings changed — restart to apply.')}
                </span>
                <div className="config-restart-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={restartApp}
                  >
                    {t('Restart now')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={cfg.dismissRestart}
                  >
                    {t('Later')}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="config-section">
            <h2 className="eyebrow config-heading">{t('AI Assistant')}</h2>
            <McpIntegration />
            <label className="config-field-label" htmlFor="diary-access-select">
              <span>{t('What AI assistants may read from your diary')}</span>
            </label>
            <select
              id="diary-access-select"
              value={diaryAccess}
              onChange={(e) => setDiaryAccess(e.target.value)}
            >
              <option value="none">{t('Nothing (off)')}</option>
              <option value="summaries">{t('Daily summaries only')}</option>
              <option value="full">{t('Summaries and written entries')}</option>
            </select>
            <p className="config-hint">
              <Rich
                text={t('Off by default. {summaries} shares your review counts, pass rates and streaks. {full} also shares anything you have written.')}
                values={{
                  summaries: <strong>{t('Daily summaries only')}</strong>,
                  full: <strong>{t('Summaries and written entries')}</strong>,
                }}
              />
            </p>
            <p className="config-hint">
              {t('This setting governs the assistant Flashback provides. It is not a lock on the folder: an assistant that can run commands on this computer can read your diary files whatever you choose here.')}
            </p>
          </section>

          <section className="config-section">
            <h2 className="eyebrow config-heading">{t('About')}</h2>
            <AboutUpdates />
          </section>
        </>
      )}

      {migrating && (
        <ProgressDialog
          title={t('Translating progress…')}
          statusText={t('Mapping intervals to the new algorithm')}
          progress={0}
          processing
        />
      )}
    </div>
  );
}
