/**
 * The wizard's four screens: welcome, the vault (name, scheduler, location), who you are,
 * and the review before anything is written. Each validates its own fields with the
 * sentences from validation.js. Who you are starts blank, with the computer account as the
 * placeholder: blank is a valid answer (that account is stamped), while a name filled in
 * for you beside an empty email is not. The scheduler reads as it does in Config → Study (the same
 * control and the same sentences), since that is where it is changed later.
 */

import { useState, useEffect } from 'react';
import { LOCALE_OPTIONS, useT } from '../../translations/index';
import { LanguagePicker } from '../../translations/components.jsx';
import SegmentedControl from '../../components/base/SegmentedControl';
import Toggle from '../../components/base/Toggle';
import { getStoredIdentity } from '../../api/identity.js';
import { getUserDataPath, isDesktop } from '../../api/desktop';
import { nameError, joinPath, identityProblem, bothBlank, SCHEDULERS } from './validation.js';

/** One sentence per scheduler, the same as Config → Study's. */
function schedulerHint(id, t) {
  switch (id) {
    case 'leitner': return t('Cards move up a box when you remember them and back to the first when you don’t; each box doubles the gap.');
    case 'sm2': return t('Each card has an ease factor that grows or shrinks with your grades and stretches the gap.');
    case 'fsrs': return t('A memory model that predicts when you’re about to forget each card, fitted to your own history.');
    default: return '';
  }
}

/** Where the vault would land, once Electron has said where its data lives. */
function useDataPath() {
  const [dataPath, setDataPath] = useState('');
  useEffect(() => {
    if (isDesktop()) getUserDataPath().then((p) => setDataPath(p ?? '')).catch(() => {});
  }, []);
  return dataPath;
}

/** The identity Flashback falls back on (the computer account), or null. */
function useSuggestedIdentity() {
  const [suggested, setSuggested] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getStoredIdentity().then((stored) => {
      if (!cancelled) setSuggested(stored?.suggested?.name ? stored.suggested : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return suggested;
}

/** The steps as a ladder: done, here, still to come. */
export function StepLadder({ step, labels }) {
  const { t } = useT();
  return (
    <ol className="ob-ladder" aria-label={t('Step {step} of {total}', { step: step + 1, total: labels.length })}>
      {labels.map((label, i) => (
        <li
          key={label}
          className={`ob-rung${i < step ? ' is-done' : ''}${i === step ? ' is-here' : ''}`}
          aria-current={i === step ? 'step' : undefined}
        >
          <i aria-hidden="true" />
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function StepHead({ title, lede }) {
  return (
    <header className="ob-head">
      <h1 className="ob-title">{title}</h1>
      {lede && <p className="ob-lede">{lede}</p>}
    </header>
  );
}

function StepNav({ onBack, onNext, nextLabel, busy = false }) {
  const { t } = useT();
  return (
    <div className="ob-nav">
      {onBack && <button type="button" className="btn btn--ghost" onClick={onBack} disabled={busy}>{t('Back')}</button>}
      {onBack && <span className="ob-grow" />}
      <button type="button" className="btn btn--quiet-accent" onClick={onNext} disabled={busy}>{nextLabel ?? t('Next')}</button>
    </div>
  );
}

export function StepWelcome({ onNext }) {
  const { t } = useT();
  return (
    <div className="ob-step ob-step--welcome">
      <svg className="ob-mark" width="44" height="44" viewBox="0 0 52 52" fill="none" aria-hidden="true">
        <path d="M26 6L46 26L26 46L6 26Z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M26 16L36 26L26 36L16 26Z" fill="currentColor" />
      </svg>
      <StepHead
        title={t('Welcome to Flashback')}
        lede={t('The desk where reading becomes memory: read, mark, write the card, file it, in a vault you own.')}
      />
      <p className="ob-p">{t('Setting up takes a minute: a vault, your name, and a look at both before anything is written.')}</p>
      <StepNav onNext={onNext} nextLabel={t('Get started')} />
      {LOCALE_OPTIONS.length > 1 && (
        <div className="ob-locale">
          <label htmlFor="ob-locale-select">{t('Language')}</label>
          <LanguagePicker id="ob-locale-select" className="field field--sm" />
        </div>
      )}
    </div>
  );
}

export function StepVault({ state, onChange, onNext, onBack }) {
  const { t } = useT();
  const { vaultName, isCustomPath, customPath, port, logFormat, algorithm } = state;
  const [touched, setTouched] = useState(false);
  const dataPath = useDataPath();

  const err = nameError(vaultName, t);
  const pathMissing = isCustomPath && !customPath.trim();
  const previewBase = isCustomPath ? (customPath.trim() || '…') : (dataPath || '…');
  const previewPath = joinPath(previewBase, vaultName.trim() || '…');

  const handleNext = () => {
    setTouched(true);
    if (!err && !pathMissing) onNext();
  };

  return (
    <div className="ob-step">
      <StepHead
        title={t('Name your vault')}
        lede={t('A vault is a self-contained workspace: its own folder of documents and its own database, on your disk.')}
      />

      <div className="ob-field">
        <label className="ob-label" htmlFor="ob-vault-name">{t('Vault name')}</label>
        <input
          id="ob-vault-name"
          className={`field ob-in${touched && err ? ' is-invalid' : ''}`}
          value={vaultName}
          onChange={(e) => { onChange('vaultName', e.target.value); setTouched(false); }}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && !!err}
          aria-describedby="ob-vault-name-msg"
          placeholder="dreams"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        {touched && err
          ? <span id="ob-vault-name-msg" className="ob-msg is-error">{err}</span>
          : <span id="ob-vault-name-msg" className="ob-msg ob-path" title={previewPath}>{previewPath}</span>}
      </div>

      <div className="ob-field">
        <span className="ob-label">{t('Scheduler')}</span>
        <SegmentedControl
          label={t('Scheduler')}
          value={algorithm}
          onChange={(v) => onChange('algorithm', v)}
          options={SCHEDULERS}
        />
        <span className="ob-msg">{schedulerHint(algorithm, t)} {t('You can change it later in Config → Study.')}</span>
      </div>

      <div className="ob-field">
        <div className="ob-switch">
          <span className="ob-label" id="ob-custom-label">{t('Keep the vault in a folder of your choosing')}</span>
          <Toggle checked={isCustomPath} onChange={(v) => onChange('isCustomPath', v)} ariaLabel={t('Keep the vault in a folder of your choosing')} />
        </div>
        {isCustomPath && (
          <div className="ob-sub">
            <input
              className={`field ob-in${touched && pathMissing ? ' is-invalid' : ''}`}
              value={customPath}
              onChange={(e) => onChange('customPath', e.target.value)}
              aria-labelledby="ob-custom-label"
              aria-invalid={touched && pathMissing}
              placeholder="C:\Users\you\Vaults"
              spellCheck={false}
              autoComplete="off"
            />
            <span className={`ob-msg${touched && pathMissing ? ' is-error' : ''}`}>
              {touched && pathMissing ? t('Required.') : t('An absolute path. The vault’s folder is made inside it.')}
            </span>
          </div>
        )}
      </div>

      <details className="ob-more">
        <summary>{t('Advanced')}</summary>
        <div className="ob-more__rows">
          <label className="ob-row" htmlFor="ob-port">
            <span>{t('API port')}</span>
            <input
              id="ob-port"
              className="field ob-num"
              type="number"
              value={port}
              min={1024}
              max={65535}
              onChange={(e) => onChange('port', Number(e.target.value))}
            />
          </label>
          <label className="ob-row" htmlFor="ob-log">
            <span>{t('Log format')}</span>
            <select id="ob-log" className="field" value={logFormat} onChange={(e) => onChange('logFormat', e.target.value)}>
              <option value="dev">dev</option>
              <option value="combined">combined</option>
              <option value="tiny">tiny</option>
              <option value="short">short</option>
            </select>
          </label>
        </div>
      </details>

      <StepNav onBack={onBack} onNext={handleNext} />
    </div>
  );
}

export function StepIdentity({ state, onChange, onNext, onBack }) {
  const { t } = useT();
  const { userName, userEmail } = state;
  const [touched, setTouched] = useState(false);
  const suggested = useSuggestedIdentity();

  const skipping = bothBlank({ name: userName, email: userEmail });
  const problem = skipping ? null : identityProblem({ name: userName, email: userEmail }, t);
  const stamp = skipping
    ? (suggested ? `${suggested.name} <${suggested.email}>` : null)
    : `${userName.trim()} <${userEmail.trim()}>`;

  const handleNext = () => {
    setTouched(true);
    if (!problem) onNext();
  };

  return (
    <div className="ob-step">
      <StepHead
        title={t('Who’s studying?')}
        lede={t('Your name and email are stamped on documents you create and on every entry in the vault history. Nothing checks it and nothing signs you in.')}
      />

      <div className="ob-field">
        <label className="ob-label" htmlFor="ob-user-name">{t('Name')}</label>
        <input
          id="ob-user-name"
          className="field ob-in"
          value={userName}
          onChange={(e) => { onChange('userName', e.target.value); setTouched(false); }}
          onBlur={() => setTouched(true)}
          placeholder={suggested?.name}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="ob-field">
        <label className="ob-label" htmlFor="ob-user-email">{t('Email')}</label>
        <input
          id="ob-user-email"
          className={`field ob-in${touched && problem ? ' is-invalid' : ''}`}
          type="email"
          value={userEmail}
          onChange={(e) => { onChange('userEmail', e.target.value); setTouched(false); }}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && !!problem}
          aria-describedby="ob-user-msg"
          placeholder={suggested?.email}
          spellCheck={false}
          autoComplete="off"
        />
        {touched && problem && <span id="ob-user-msg" className="ob-msg is-error">{problem}</span>}
      </div>

      {!(touched && problem) && (
        <div className="ob-stamp">
          {stamp && <p>{t('Stamping new work as')} <code>{stamp}</code></p>}
          <span className="ob-msg">
            {skipping
              ? t('Leave both blank and Flashback uses your computer’s account. You can change this later in Config → You.')
              : t('You can change this later in Config → You, and keep a different address for a particular vault.')}
          </span>
        </div>
      )}

      <StepNav onBack={onBack} onNext={handleNext} />
    </div>
  );
}

export function StepReady({ state, onBack, onSubmit, submitting, submitError, preview }) {
  const { t } = useT();
  const { vaultName, isCustomPath, customPath, port, logFormat, algorithm, userName, userEmail } = state;
  const dataPath = useDataPath();
  const suggested = useSuggestedIdentity();

  const author = bothBlank({ name: userName, email: userEmail })
    ? (suggested ? `${suggested.name} <${suggested.email}>` : '…')
    : `${userName.trim()} <${userEmail.trim()}>`;
  const previewBase = isCustomPath ? (customPath.trim() || '…') : (dataPath || '…');
  const vaultPath = joinPath(previewBase, vaultName.trim());
  const scheduler = SCHEDULERS.find((s) => s.value === algorithm)?.label ?? algorithm;

  return (
    <div className="ob-step">
      <StepHead
        title={t('You’re all set')}
        lede={preview
          ? t('This is a preview: Flashback is already set up, so finishing writes nothing and opens the app as it is.')
          : t('Nothing is written until you create the vault. Go back to change anything.')}
      />

      <dl className="ob-facts">
        <dt>{t('Vault')}</dt>
        <dd>{vaultName.trim()}</dd>
        <dt>{t('Documents')}</dt>
        <dd className="ob-mono">{joinPath(vaultPath, 'workspace')}</dd>
        <dt>{t('Database')}</dt>
        <dd className="ob-mono">{joinPath(vaultPath, `${vaultName.trim()}.db`)}</dd>
        <dt>{t('Stamped as')}</dt>
        <dd className="ob-mono">{author}</dd>
        <dt>{t('Scheduler')}</dt>
        <dd>{scheduler}</dd>
        <dt>{t('API port')}</dt>
        <dd className="ob-mono">{port}</dd>
        <dt>{t('Log format')}</dt>
        <dd className="ob-mono">{logFormat}</dd>
      </dl>

      {submitError && <p className="ob-error" role="alert">{submitError}</p>}

      <StepNav
        onBack={onBack}
        onNext={onSubmit}
        busy={submitting}
        nextLabel={preview
          ? t('Finish preview')
          : submitting ? t('Creating vault…') : t('Create vault')}
      />
    </div>
  );
}
