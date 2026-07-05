import { useState, useEffect } from "react";
import "./Setup.css";
import "../App.css";
import TitleBar from "../components/TitleBar";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Windows-illegal filename chars, including control chars (intentional).
// eslint-disable-next-line no-control-regex
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/;

function nameError(v) {
  if (!v.trim()) return "Required.";
  if (INVALID_NAME.test(v.trim())) return "Contains invalid characters.";
  if (v.trim().length > 64) return "Too long (max 64 characters).";
  return null;
}

function joinPath(...parts) {
  return parts.join("\\").replace(/\\+/g, "\\");
}

// ── Shared chrome ─────────────────────────────────────────────────────────────

function StepDots({ step, total }) {
  return (
    <div className="ob-stepdots" aria-label={`Step ${step + 1} of ${total}`}>
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
  return (
    <div className="ob-step ob-step--welcome">
      <svg className="ob-mark" width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true">
        <path d="M26 6L46 26L26 46L6 26Z" stroke="var(--color-accent)" strokeWidth="1.5"/>
        <path d="M26 16L36 26L26 36L16 26Z" fill="var(--color-accent)"/>
      </svg>

      <h1 className="ob-welcome-title">Welcome to Flashback</h1>
      <p className="ob-welcome-desc">
        A knowledge database with all your spaced repetition needs.<br/>
        Your notes, documents, and flashcards — all in one place.
      </p>

      <button type="button" className="ob-btn-primary ob-btn-lg" onClick={onNext}>
        Get started
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <line x1="2" y1="7" x2="12" y2="7"/>
          <polyline points="8,3 12,7 8,11"/>
        </svg>
      </button>
    </div>
  );
}

// ── Step 1 — Vault setup ──────────────────────────────────────────────────────

function StepVault({ state, onChange, onNext, onBack }) {
  const { vaultName, isCustomPath, customPath, port, logFormat, algorithm } = state;
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched]   = useState(false);
  const [dataPath, setDataPath] = useState("");

  useEffect(() => {
    if (window.flashback?.getUserDataPath) {
      window.flashback.getUserDataPath().then(p => setDataPath(p ?? ""));
    }
  }, []);

  const err = nameError(vaultName);
  const previewBase = isCustomPath ? (customPath.trim() || "…") : (dataPath || "…");
  const previewPath = joinPath(previewBase, vaultName.trim() || "…");
  const canNext = !err && (!isCustomPath || customPath.trim());

  const handleNext = () => {
    setTouched(true);
    if (canNext) onNext();
  };

  return (
    <div className="ob-step">
      <h2 className="ob-step-title">Name your vault</h2>
      <p className="ob-step-desc">
        A vault is a self-contained workspace — its own folder and database on disk.
      </p>

      <div className="ob-field">
        <label className="ob-label" htmlFor="ob-vault-name">Vault name</label>
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
        <label className="ob-label">SRS algorithm</label>
        <div className="ob-algo-group">
          <label className={`ob-algo-option${algorithm === 'sm2' ? ' ob-algo-option--active' : ''}`}>
            <input
              type="radio"
              name="ob-algorithm"
              value="leitner"
              checked={algorithm === 'leitner'}
              onChange={() => onChange("algorithm", "leitner")}
            />
            <span className="ob-algo-name">Leitner</span>
            <span className="ob-algo-desc">Box system — intervals double each level. Simple and effective.</span>
          </label>
          <label className={`ob-algo-option${algorithm === 'sm2' ? ' ob-algo-option--active' : ''}`}>
            <input
              type="radio"
              name="ob-algorithm"
              value="sm2"
              checked={algorithm === 'sm2'}
              onChange={() => onChange("algorithm", "sm2")}
            />
            <span className="ob-algo-name">SM-2</span>
            <span className="ob-algo-desc">Ease factor — adapts to your recall speed. Better for large collections.</span>
          </label>
        </div>
        <span className="ob-field-msg">You can change this later in Settings → Flashcards.</span>
      </div>

      <div className="ob-divider" />

      <label className="ob-check-row">
        <input
          type="checkbox"
          className="ob-checkbox"
          checked={isCustomPath}
          onChange={e => onChange("isCustomPath", e.target.checked)}
        />
        <span className="ob-check-label">Store vault at a custom location</span>
      </label>

      {isCustomPath && (
        <div className="ob-field ob-field--indented">
          <label className="ob-label" htmlFor="ob-custom-path">Vault root folder</label>
          <input
            id="ob-custom-path"
            className="ob-input"
            value={customPath}
            onChange={e => onChange("customPath", e.target.value)}
            placeholder="C:\Users\you\Vaults"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="ob-field-msg">Absolute path — the vault folder will be created inside it.</span>
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
        Advanced
      </button>

      {advanced && (
        <div className="ob-advanced">
          <div className="ob-inline-row">
            <label className="ob-label" htmlFor="ob-port">API port</label>
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
            <label className="ob-label" htmlFor="ob-log">Log format</label>
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
        <button type="button" className="ob-btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="ob-btn-primary" onClick={handleNext}>
          Next
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <line x1="2" y1="7" x2="12" y2="7"/>
            <polyline points="8,3 12,7 8,11"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Step 2 — Review & create ──────────────────────────────────────────────────

function StepReady({ state, onBack, onSubmit, submitting, submitError }) {
  const { vaultName, isCustomPath, customPath, port, logFormat, algorithm } = state;
  const [dataPath, setDataPath] = useState("");

  useEffect(() => {
    if (window.flashback?.getUserDataPath) {
      window.flashback.getUserDataPath().then(p => setDataPath(p ?? ""));
    }
  }, []);

  const previewBase = isCustomPath ? (customPath.trim() || "…") : (dataPath || "…");
  const vaultPath   = joinPath(previewBase, vaultName.trim());
  const dbPath      = joinPath(vaultPath, `${vaultName.trim()}.db`);

  return (
    <div className="ob-step">
      <h2 className="ob-step-title">You&rsquo;re all set</h2>
      <p className="ob-step-desc">Review your vault settings before creating it.</p>

      <div className="ob-summary">
        <div className="ob-summary-row">
          <span className="ob-summary-key">Vault name</span>
          <span className="ob-summary-val">{vaultName}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">Documents</span>
          <span className="ob-summary-val ob-summary-val--path">{joinPath(vaultPath, "workspace")}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">Database</span>
          <span className="ob-summary-val ob-summary-val--path">{dbPath}</span>
        </div>
        <div className="ob-summary-divider" />
        <div className="ob-summary-row">
          <span className="ob-summary-key">SRS algorithm</span>
          <span className="ob-summary-val">{algorithm === 'sm2' ? 'SM-2' : 'Leitner'}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">API port</span>
          <span className="ob-summary-val">{port}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-summary-key">Log format</span>
          <span className="ob-summary-val">{logFormat}</span>
        </div>
      </div>

      {submitError && <p className="ob-submit-error">{submitError}</p>}

      <div className="ob-nav">
        <button type="button" className="ob-btn-ghost" onClick={onBack} disabled={submitting}>Back</button>
        <button type="button" className="ob-btn-primary" onClick={onSubmit} disabled={submitting}>
          {submitting ? "Creating vault…" : "Create vault"}
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
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    vaultName:    "dreams",
    isCustomPath: false,
    customPath:   "",
    port:         50500,
    logFormat:    "dev",
    algorithm:    "leitner",
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
    const result = await window.flashback.completeSetup({
      port:         form.port,
      logFormat:    form.logFormat,
      host:         "localhost",
      isLocalhost:  true,
      isCustomPath: form.isCustomPath,
      customPath:   form.customPath.trim(),
      vaultName:    form.vaultName.trim(),
    });
    if (result?.ok) {
      localStorage.setItem("fb-srs-algorithm", form.algorithm);
      await onComplete();
    } else {
      setSubmitError(result?.error ?? "Setup failed. Check the path and try again.");
      setSubmitting(false);
    }
  };

  const TOTAL = 3;

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
            <StepReady
              state={form}
              onBack={() => setStep(1)}
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
