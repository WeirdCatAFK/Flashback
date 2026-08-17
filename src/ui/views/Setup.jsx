import { useState, useEffect } from "react";
import "./Setup.css";
import "../App.css";
import TitleBar from "../components/TitleBar";
import { LanguagePicker, LOCALE_OPTIONS, useT } from "../translations/index.jsx";
import { vaultNameError } from "../../shared/vaultName.js";
import { identityError } from "../../shared/identity.js";
import { getStoredIdentity } from "../api/identity.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// The rules themselves live in src/shared/vaultName.js so the Electron main process — the
// half that actually creates and renames folders — validates identically. This wraps the
// returned code in a translated sentence.
function nameError(v, t) {
  switch (vaultNameError(v)) {
    case "required":      return t("Required.");
    case "invalid-chars": return t("Contains invalid characters.");
    case "too-long":      return t("Too long (max 64 characters).");
    case "trailing-dot":  return t("Cannot end with a dot or a space.");
    case "reserved":      return t("That name is reserved.");
    default:              return null;
  }
}

function joinPath(...parts) {
  return parts.join("\\").replace(/\\+/g, "\\");
}

// Same arrangement as nameError above: the rules are shared with the Electron main process,
// the sentences are translated here.
function identityProblem(identity, t) {
  const problem = identityError(identity);
  if (!problem) return null;
  switch (problem.code) {
    case "required":       return problem.field === "name" ? t("A name is required.") : t("An email is required.");
    case "invalid-chars":  return t("Contains characters that cannot be used here.");
    case "too-long":       return t("Too long (max 128 characters).");
    case "not-an-address": return t("That does not look like an email address.");
    default:               return t("Something went wrong.");
  }
}

// Both blank means "skip" — nothing is written and the resolver falls back to the computer
// account. One blank means a half-filled identity, which cannot produce an author line.
function bothBlank({ name, email }) {
  return !name.trim() && !email.trim();
}

// ── Shared chrome ─────────────────────────────────────────────────────────────

function StepDots({ step, total }) {
  const { t } = useT();
  return (
    <div className="ob-stepdots" aria-label={t('Step {step} of {total}', { step: step + 1, total })}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`ob-dot${i === step ? " ob-dot--active" : i < step ? " ob-dot--done" : ""}`}
        />
      ))}
    </div>
  );
}

// ── Step 0 — Welcome ──────────────────────────────────────────────────────────

function StepWelcome({ onNext }) {
  const { t } = useT();
  return (
    <div className="ob-step ob-step--welcome">
      <svg className="ob-mark" width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true">
        <path d="M26 6L46 26L26 46L6 26Z" stroke="var(--color-accent)" strokeWidth="1.5"/>
        <path d="M26 16L36 26L26 36L16 26Z" fill="var(--color-accent)"/>
      </svg>

      <h1 className="ob-welcome-title">{t('Welcome to Flashback')}</h1>
      <p className="ob-welcome-desc">
        {t('A knowledge database with all your spaced repetition needs.')}<br/>
        {t('Your notes, documents, and flashcards — all in one place.')}
      </p>

      <button type="button" className="ob-btn-primary ob-btn-lg" onClick={onNext}>
        {t('Get started')}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <line x1="2" y1="7" x2="12" y2="7"/>
          <polyline points="8,3 12,7 8,11"/>
        </svg>
      </button>

      {/* Only worth showing once a pack exists — on a build with none, this is
          a one-option select that just adds noise to the first screen. */}
      {LOCALE_OPTIONS.length > 1 && (
        <div className="ob-locale">
          <label htmlFor="ob-locale-select">{t('Language')}</label>
          <LanguagePicker id="ob-locale-select" />
        </div>
      )}
    </div>
  );
}

// ── Step 1 — Vault setup ──────────────────────────────────────────────────────

function StepVault({ state, onChange, onNext, onBack }) {
  const { t } = useT();
  const { vaultName, isCustomPath, customPath, port, logFormat, algorithm } = state;
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched]   = useState(false);
  const [dataPath, setDataPath] = useState("");

  useEffect(() => {
    if (window.flashback?.getUserDataPath) {
      window.flashback.getUserDataPath().then(p => setDataPath(p ?? ""));
    }
  }, []);

  const err = nameError(vaultName, t);
  const previewBase = isCustomPath ? (customPath.trim() || "…") : (dataPath || "…");
  const previewPath = joinPath(previewBase, vaultName.trim() || "…");
  const canNext = !err && (!isCustomPath || customPath.trim());

  const handleNext = () => {
    setTouched(true);
    if (canNext) onNext();
  };

  return (
    <div className="ob-step">
      <h2 className="ob-step-title">{t('Name your vault')}</h2>
      <p className="ob-step-desc">
        {t('A vault is a self-contained workspace — its own folder and database on disk.')}
      </p>

      <div className="ob-field">
        <label className="ob-label" htmlFor="ob-vault-name">{t('Vault name')}</label>
        <input
          id="ob-vault-name"
          className={`ob-input ob-input--lg${touched && err ? " ob-input--err" : ""}`}
          value={vaultName}
          onChange={e => { onChange("vaultName", e.target.value); setTouched(false); }}
          onBlur={() => setTouched(true)}
          placeholder="dreams"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        {touched && err
          ? <span className="ob-field-msg ob-field-msg--err">{err}</span>
          : (
            <span className="ob-field-msg ob-path-preview">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                <rect x="1" y="3" width="9" height="7" rx="0"/>
                <path d="M1 5h9M4 3V1h3v2"/>
              </svg>
              {previewPath}
            </span>
          )
        }
      </div>

      <div className="ob-divider" />

      <div className="ob-field">
        <label className="ob-label">{t('SRS algorithm')}</label>
        <div className="ob-algo-group">
          <label className={`ob-algo-option${algorithm === 'sm2' ? ' ob-algo-option--active' : ''}`}>
            <input
              type="radio"
              name="ob-algorithm"
              value="sm2"
              checked={algorithm === 'sm2'}
              onChange={() => onChange("algorithm", "sm2")}
            />
            <span className="ob-algo-name">SM-2</span>
            <span className="ob-algo-desc">{t('Ease factor — adapts to your recall speed. Better for large collections.')}</span>
          </label>
          <label className={`ob-algo-option${algorithm === 'leitner' ? ' ob-algo-option--active' : ''}`}>
            <input
              type="radio"
              name="ob-algorithm"
              value="leitner"
              checked={algorithm === 'leitner'}
              onChange={() => onChange("algorithm", "leitner")}
            />
            <span className="ob-algo-name">Leitner</span>
            <span className="ob-algo-desc">{t('Box system — intervals double each level. Simple and effective.')}</span>
          </label>
          <label className={`ob-algo-option${algorithm === 'fsrs' ? ' ob-algo-option--active' : ''}`}>
            <input
              type="radio"
              name="ob-algorithm"
              value="fsrs"
              checked={algorithm === 'fsrs'}
              onChange={() => onChange("algorithm", "fsrs")}
            />
            <span className="ob-algo-name">FSRS</span>
            <span className="ob-algo-desc">{t('Memory model — predicts recall to minimise reviews. Most efficient; the modern default.')}</span>
          </label>
        </div>
        <span className="ob-field-msg">{t('You can change this later in Settings → Flashcards.')}</span>
      </div>

      <div className="ob-divider" />

      <label className="ob-check-row">
        <input
          type="checkbox"
          className="ob-checkbox"
          checked={isCustomPath}
          onChange={e => onChange("isCustomPath", e.target.checked)}
        />
        <span className="ob-check-label">{t('Store vault at a custom location')}</span>
      </label>

      {isCustomPath && (
        <div className="ob-field ob-field--indented">
          <label className="ob-label" htmlFor="ob-custom-path">{t('Vault root folder')}</label>
          <input
            id="ob-custom-path"
            className="ob-input"
            value={customPath}
            onChange={e => onChange("customPath", e.target.value)}
            placeholder="C:\Users\you\Vaults"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="ob-field-msg">{t('Absolute path — the vault folder will be created inside it.')}</span>
        </div>
      )}

      <button
        type="button"
        className="ob-advanced-toggle"
        aria-expanded={advanced}
        onClick={() => setAdvanced(v => !v)}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.5"
          aria-hidden="true"
          style={{ transform: advanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 140ms ease" }}>
          <polyline points="2,1 7,4.5 2,8"/>
        </svg>
        {t('Advanced')}
      </button>

      {advanced && (
        <div className="ob-advanced">
          <div className="ob-inline-row">
            <label className="ob-label" htmlFor="ob-port">{t('API port')}</label>
            <input
              id="ob-port"
              className="ob-input ob-input--short"
              type="number"
              value={port}
              min={1024}
              max={65535}
              onChange={e => onChange("port", Number(e.target.value))}
            />
          </div>
          <div className="ob-inline-row">
            <label className="ob-label" htmlFor="ob-log">{t('Log format')}</label>
            <select
              id="ob-log"
              className="ob-select"
              value={logFormat}
              onChange={e => onChange("logFormat", e.target.value)}
            >
              <option value="dev">dev</option>
              <option value="combined">combined</option>
              <option value="tiny">tiny</option>
              <option value="short">short</option>
            </select>
          </div>
        </div>
      )}

      <div className="ob-nav">
        <button type="button" className="ob-btn-ghost" onClick={onBack}>{t('Back')}</button>
        <button type="button" className="ob-btn-primary" onClick={handleNext}>
          {t('Next')}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <line x1="2" y1="7" x2="12" y2="7"/>
            <polyline points="8,3 12,7 8,11"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Step 2 — Who's studying ───────────────────────────────────────────────────

function StepIdentity({ state, onChange, onNext, onBack }) {
  const { t } = useT();
  const { userName, userEmail } = state;
  const [touched, setTouched] = useState(false);
  const [suggested, setSuggested] = useState(null);

  // Over IPC, not HTTP — the API process does not exist yet at this point in setup. The
  // suggestion comes from the OS account and is shaped by the same rule the API falls back
  // to, so what is offered here is exactly what would be stamped if this step is skipped.
  useEffect(() => {
    let cancelled = false;
    getStoredIdentity().then((stored) => {
      // Guarded on `name`, not just presence: the non-Electron fallback returns an empty
      // pair, and rendering it would offer the user "  <>" as their identity.
      if (cancelled || !stored?.suggested?.name) return;
      setSuggested(stored.suggested);
      // Pre-fill the name only. The address is the half worth asking for — the suggested
      // one is a `.local` placeholder that reaches nobody.
      if (!state.userName) onChange("userName", stored.suggested.name);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skipping = bothBlank({ name: userName, email: userEmail });
  const problem = skipping ? null : identityProblem({ name: userName, email: userEmail }, t);

  const handleNext = () => {
    setTouched(true);
    if (!problem) onNext();
  };

  return (
    <div className="ob-step">
      <h2 className="ob-step-title">{t('Who’s studying?')}</h2>
      <p className="ob-step-desc">
        {t('Your name and email are stamped on documents you create and on every entry in the vault history — the way git records who wrote a commit. This is an authoring label, not an account: nothing checks it and nothing signs you in.')}
      </p>

      <div className="ob-field">
        <label className="ob-label" htmlFor="ob-user-name">{t('Name')}</label>
        <input
          id="ob-user-name"
          className="ob-input ob-input--lg"
          value={userName}
          onChange={e => { onChange("userName", e.target.value); setTouched(false); }}
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
          className={`ob-input ob-input--lg${touched && problem ? " ob-input--err" : ""}`}
          type="email"
          value={userEmail}
          onChange={e => { onChange("userEmail", e.target.value); setTouched(false); }}
          onBlur={() => setTouched(true)}
          placeholder={suggested?.email}
          spellCheck={false}
          autoComplete="off"
        />
        {touched && problem
          ? <span className="ob-field-msg ob-field-msg--err">{problem}</span>
          : (
            <span className="ob-field-msg">
              {skipping && suggested
                ? t('Leave both blank and Flashback uses {fallback}. You can change this later in Settings.')
                    .replace('{fallback}', `${suggested.name} <${suggested.email}>`)
                : t('You can change this later in Settings, and keep a different address for a particular vault.')}
            </span>
          )
        }
      </div>

      <div className="ob-nav">
        <button type="button" className="ob-btn-ghost" onClick={onBack}>{t('Back')}</button>
        <button type="button" className="ob-btn-primary" onClick={handleNext}>
          {t('Next')}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <line x1="2" y1="7" x2="12" y2="7"/>
            <polyline points="8,3 12,7 8,11"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Step 3 — Review & create ──────────────────────────────────────────────────

function StepReady({ state, onBack, onSubmit, submitting, submitError }) {
  const { t } = useT();
  const { vaultName, isCustomPath, customPath, port, logFormat, algorithm,
          userName, userEmail } = state;
  const [dataPath, setDataPath] = useState("");
  const [suggested, setSuggested] = useState(null);

  useEffect(() => {
    if (window.flashback?.getUserDataPath) {
      window.flashback.getUserDataPath().then(p => setDataPath(p ?? ""));
    }
    getStoredIdentity().then(s => setSuggested(s?.suggested?.name ? s.suggested : null));
  }, []);

  const skippedIdentity = bothBlank({ name: userName, email: userEmail });
  const authorLine = skippedIdentity
    ? (suggested ? `${suggested.name} <${suggested.email}>` : "…")
    : `${userName.trim()} <${userEmail.trim()}>`;

  const previewBase = isCustomPath ? (customPath.trim() || "…") : (dataPath || "…");
  const vaultPath   = joinPath(previewBase, vaultName.trim());
  const dbPath      = joinPath(vaultPath, `${vaultName.trim()}.db`);

  return (
    <div className="ob-step">
      <h2 className="ob-step-title">{t('You’re all set')}</h2>
      <p className="ob-step-desc">{t('Review your vault settings before creating it.')}</p>

      <div className="ob-summary">
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('Vault name')}</span>
          <span className="ob-summary-val">{vaultName}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('Documents')}</span>
          <span className="ob-summary-val ob-summary-val--path">{joinPath(vaultPath, "workspace")}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('Database')}</span>
          <span className="ob-summary-val ob-summary-val--path">{dbPath}</span>
        </div>
        <div className="ob-summary-divider" />
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('Stamped as')}</span>
          <span className="ob-summary-val ob-summary-val--path">{authorLine}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('SRS algorithm')}</span>
          {/* Algorithm names are proper nouns, the same in every language. */}
          <span className="ob-summary-val">{algorithm === 'sm2' ? 'SM-2' : algorithm === 'fsrs' ? 'FSRS' : 'Leitner'}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('API port')}</span>
          <span className="ob-summary-val">{port}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">{t('Log format')}</span>
          <span className="ob-summary-val">{logFormat}</span>
        </div>
      </div>

      {submitError && <p className="ob-submit-error">{submitError}</p>}

      <div className="ob-nav">
        <button type="button" className="ob-btn-ghost" onClick={onBack} disabled={submitting}>{t('Back')}</button>
        <button type="button" className="ob-btn-primary" onClick={onSubmit} disabled={submitting}>
          {submitting ? t('Creating vault…') : t('Create vault')}
          {!submitting && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <line x1="2" y1="7" x2="12" y2="7"/>
              <polyline points="8,3 12,7 8,11"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function SetupView({ onComplete }) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    vaultName:    "dreams",
    isCustomPath: false,
    customPath:   "",
    port:         50500,
    logFormat:    "dev",
    algorithm:    "sm2",
    userName:     "",
    userEmail:    "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem("fb-theme") ?? "light-workbench";
    document.documentElement.setAttribute("data-theme", saved);
  }, []);

  const handleChange = (key, value) => setForm(f => ({ ...f, [key]: value }));

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);

    const config = {
      port:         form.port,
      logFormat:    form.logFormat,
      host:         "localhost",
      isLocalhost:  true,
      isCustomPath: form.isCustomPath,
      customPath:   form.customPath.trim(),
      vaultName:    form.vaultName.trim(),
    };

    // Written into the very first config, before the API is spawned, so the vault's own
    // seed documents and its first Seal commit are already stamped correctly. Omitted
    // entirely when the step was skipped — an absent `user` resolves to the computer
    // account, which is more honest than storing that placeholder as a real setting.
    if (!bothBlank({ name: form.userName, email: form.userEmail })) {
      config.user = { name: form.userName.trim(), email: form.userEmail.trim() };
    }

    const result = await window.flashback.completeSetup(config);
    if (result?.ok) {
      // Written to the GLOBAL key deliberately: the vault has no id yet at this point in
      // setup. prefs.js reads a vault-scoped key by falling back to the global one and
      // copying it forward, so this becomes the first vault's algorithm — and the
      // starting point for any vault created later.
      localStorage.setItem("fb-srs-algorithm", form.algorithm);
      await onComplete();
    } else {
      setSubmitError(result?.error ?? t('Setup failed. Check the path and try again.'));
      setSubmitting(false);
    }
  };

  const TOTAL = 4;

  return (
    <div className="ob-shell">
      <TitleBar />
      <div className="ob-body">
        <div className="ob-card">
          <StepDots step={step} total={TOTAL} />

          {step === 0 && (
            <StepWelcome onNext={() => setStep(1)} />
          )}
          {step === 1 && (
            <StepVault
              state={form}
              onChange={handleChange}
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
            />
          )}
          {step === 2 && (
            <StepIdentity
              state={form}
              onChange={handleChange}
              onNext={() => setStep(3)}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && (
            <StepReady
              state={form}
              onBack={() => setStep(2)}
              onSubmit={handleSubmit}
              submitting={submitting}
              submitError={submitError}
            />
          )}
        </div>
      </div>
    </div>
  );
}
