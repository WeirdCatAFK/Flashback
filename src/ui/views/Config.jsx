import { useState, useEffect, useMemo } from "react";
import "./Config.css";
import KeybindingsEditor from "../components/KeybindingsEditor";
import ProgressDialog from "../components/shared/ProgressDialog";
import { LoadingState, ErrorState } from "../components/shared/StateView";
import { migrateProgress, optimizeFsrs, getFsrsInfo } from "../api/srs";
import { THEMES } from "../themes";
import { LanguagePicker, Rich, useT } from "../translations/index.jsx";
import {
  THEME_VARS,
  saveCustomTheme,
  deleteCustomTheme,
  loadCustomThemes,
  resolvedThemeColors,
} from "../customThemes";

// ── Backend config ────────────────────────────────────────────────────────────

function useConfig() {
  const [config, setConfig] = useState(null);
  // window.flashback is injected by Electron's preload before React renders,
  // so we can read it synchronously here to set the correct initial state.
  const [loading, setLoading] = useState(!!window.flashback);
  const [error, setError] = useState(
    window.flashback
      ? null
      : new Error("window.flashback not available — run via Electron, not dev:web"),
  );

  useEffect(() => {
    if (!window.flashback) return;
    window.flashback
      .getConfig()
      .then(setConfig)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return { config, setConfig, loading, error };
}

// ── Theme editor ──────────────────────────────────────────────────────────────

const DARK_DEFAULTS = {
  "--color-bg-base":        "#1C1917",
  "--color-bg-sidebar":     "#171412",
  "--color-bg-surface":     "#292524",
  "--color-bg-hover":       "#3C3530",
  "--color-title-bar":      "#0C0A09",
  "--color-sidebar-header": "#0F0D0B",
  "--color-bg-reader":      "#201D1A",
  "--color-bg-editor":      "dark",
  "--color-fg-primary":     "#F5F5F4",
  "--color-fg-secondary":   "#A8A29E",
  "--color-fg-icon":        "#A8A29E",
  "--color-accent":         "#F59E0B",
  "--color-accent-subtle":  "#292012",
  "--color-border":         "#3C3530",
  "--color-border-strong":  "#7A6E65",
  "--color-tree-indent":    "#2C2420",
  "--color-hl-1":           "#A16207",
  "--color-hl-2":           "#4D7C0F",
  "--color-hl-3":           "#1D4ED8",
  "--color-hl-4":           "#9D174D",
  "--color-on-review":      "#1C1917",
  "--color-review-again":   "#F37373",
  "--color-review-hard":    "#F59E0B",
  "--color-review-good":    "#22C55E",
  "--color-review-easy":    "#629BF8",
  "--color-graph-edge":      "#6E635B",
  "--color-graph-document":  "#C87F00",
  "--color-graph-folder":    "#2A70C0",
  "--color-graph-flashcard": "#B35189",
  "--color-graph-tag":       "#38AD6B",
  "--color-graph-deck":      "#9881E3",
  "--color-graph-link":      "#C87F00",
  "--color-graph-disconnect":"#F87171",
  "--color-graph-inherit":   "#7BA688",
  "--color-danger":          "#F87171",
  "--color-danger-bg":       "rgba(248, 113, 113, 0.12)",
  "--shadow-sm":             "0 1px 3px rgba(0,0,0,.35)",
  "--shadow-float":          "0 6px 24px -2px rgba(0,0,0,.50), 0 2px 8px rgba(0,0,0,.22)",
};

const PREVIEW_THEME = "__fb_preview__";

/**
 * Display names for the theme variables, keyed by CSS custom property.
 *
 * customThemes.js stays the structural source of truth (which keys exist, which
 * take a raw string instead of a colour) and keeps the English label as its
 * fallback; only the text lives here. It has to, because THEME_VARS is a
 * module-level constant — translating it in place would bake one language in at
 * import time and never re-render on a language switch.
 */
function useThemeVarLabels() {
  const { t } = useT();
  return useMemo(() => ({
    "--color-bg-base":         t("Window background"),
    "--color-bg-sidebar":      t("Activity bar"),
    "--color-bg-surface":      t("Panels & cards"),
    "--color-bg-hover":        t("Hover state"),
    "--color-title-bar":       t("Title bar"),
    "--color-sidebar-header":  t("Sidebar header"),
    "--color-bg-reader":       t("Reader background"),
    "--color-bg-editor":       t("Editor theme"),
    "--color-fg-primary":      t("Primary text"),
    "--color-fg-secondary":    t("Secondary text"),
    "--color-fg-icon":         t("Inactive icons"),
    "--color-accent":          t("Accent / active"),
    "--color-accent-subtle":   t("Accent tint"),
    "--color-on-accent":       t("Text on accent"),
    "--color-border":          t("Borders"),
    "--color-border-strong":   t("Input & control borders"),
    "--color-tree-indent":     t("Tree indent line"),
    "--color-hl-1":            t("Highlight 1"),
    "--color-hl-2":            t("Highlight 2"),
    "--color-hl-3":            t("Highlight 3"),
    "--color-hl-4":            t("Highlight 4"),
    "--color-on-review":       t("Review · Button label"),
    "--color-review-again":    t("Review · Again"),
    "--color-review-hard":     t("Review · Hard"),
    "--color-review-good":     t("Review · Good"),
    "--color-review-easy":     t("Review · Easy"),
    "--color-graph-edge":      t("Graph · Resting links"),
    "--color-graph-document":  t("Graph · Document"),
    "--color-graph-folder":    t("Graph · Folder"),
    "--color-graph-flashcard": t("Graph · Flashcard"),
    "--color-graph-tag":       t("Graph · Tag"),
    "--color-graph-deck":      t("Graph · Deck"),
    "--color-graph-link":      t("Graph · Link"),
    "--color-graph-disconnect":t("Graph · Disconnect"),
    "--color-graph-inherit":   t("Graph · Inherit"),
    "--color-danger":          t("Danger / error"),
    "--color-danger-bg":       t("Danger background"),
    "--shadow-sm":             t("Resting shadow"),
    "--shadow-float":          t("Float shadow"),
  }), [t]);
}

function ThemeEditor({ onSaved, onThemeChange, currentTheme }) {
  const { t } = useT();
  const varLabels = useThemeVarLabels();
  const [open, setOpen] = useState(
    () => localStorage.getItem("fb-editor-open") === "true",
  );
  const [name, setName] = useState(
    () => localStorage.getItem("fb-editor-name") ?? "",
  );
  const [colors, setColors] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("fb-editor-colors:v1")) ?? DARK_DEFAULTS
      );
    } catch {
      return DARK_DEFAULTS;
    }
  });
  const [editing, setEditing] = useState(
    () => localStorage.getItem("fb-editor-editing") ?? null,
  );
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState(null);
  const [previewing, setPreviewing] = useState(
    () => !!document.getElementById("fb-preview-style"),
  );

  const persistName = (v) => {
    localStorage.setItem("fb-editor-name", v);
    setName(v);
  };
  const persistColors = (v) => {
    localStorage.setItem("fb-editor-colors:v1", JSON.stringify(v));
    setColors(v);
  };
  const persistEditing = (v) => {
    v
      ? localStorage.setItem("fb-editor-editing", v)
      : localStorage.removeItem("fb-editor-editing");
    setEditing(v);
  };

  const seedFromCurrent = () => persistColors(resolvedThemeColors());

  const applyPreview = (nextColors) => {
    let el = document.getElementById("fb-preview-style");
    if (!el) {
      el = document.createElement("style");
      el.id = "fb-preview-style";
      document.head.appendChild(el);
    }
    el.textContent =
      `[data-theme="${PREVIEW_THEME}"] {\n` +
      Object.entries(nextColors)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join("\n") +
      "\n}";
    onThemeChange(PREVIEW_THEME);
  };

  const stopPreview = () => {
    document.getElementById("fb-preview-style")?.remove();
    onThemeChange(currentTheme === PREVIEW_THEME ? "light-workbench" : currentTheme);
    setPreviewing(false);
  };

  const togglePreview = () => {
    if (previewing) {
      stopPreview();
    } else {
      applyPreview(colors);
      setPreviewing(true);
    }
  };

  // Keep preview in sync as colors change
  const handleColorChange = (key, value) => {
    const next = { ...colors, [key]: value };
    persistColors(next);
    if (previewing) applyPreview(next);
  };

  // Stop preview when the editor collapses
  const handleToggleOpen = () => {
    if (open && previewing) stopPreview();
    setOpen((o) => {
      localStorage.setItem("fb-editor-open", String(!o));
      return !o;
    });
  };

  const loadExisting = (themeName) => {
    const all = loadCustomThemes();
    const found = all.find((entry) => entry.name === themeName);
    if (found) {
      persistName(found.name);
      persistColors(found.colors);
      persistEditing(found.name);
    }
  };

  const exportText = JSON.stringify(
    { name: name.trim() || "my-theme", colors },
    null,
    2,
  );

  const handleCopy = () => navigator.clipboard.writeText(exportText);

  const handleImport = () => {
    setImportError(null);
    try {
      const parsed = JSON.parse(importText);
      if (typeof parsed.name !== "string" || !parsed.name.trim())
        throw new Error(t('Missing or invalid "name" field.'));
      if (typeof parsed.colors !== "object" || parsed.colors === null)
        throw new Error(t('Missing or invalid "colors" field.'));
      const missing = THEME_VARS.filter(({ key }) => !(key in parsed.colors));
      if (missing.length > THEME_VARS.length / 2)
        throw new Error(
          t("Missing variables: {list}", { list: missing.map((v) => v.key).join(", ") }),
        );
      persistName(parsed.name.trim());
      persistColors(parsed.colors);
      if (previewing) applyPreview(parsed.colors);
      persistEditing(null);
      setImportText("");
    } catch (err) {
      setImportError(err.message);
    }
  };

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed || THEMES.includes(trimmed)) return;
    saveCustomTheme({ name: trimmed, colors });
    onSaved(trimmed);
    onThemeChange(trimmed);
    persistEditing(trimmed);
  };

  const handleDelete = () => {
    if (!editing) return;
    deleteCustomTheme(editing);
    onSaved(null);
    persistName("");
    persistColors(DARK_DEFAULTS);
    persistEditing(null);
  };

  const isNameTaken = THEMES.includes(name.trim()) && name.trim() !== "";
  const canSave = name.trim() && !isNameTaken;

  return (
    <div className="theme-editor">
      <button type="button" className="theme-editor-toggle" onClick={handleToggleOpen}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 150ms ease",
          }}
        >
          <polyline points="4,2 9,6 4,10" />
        </svg>
        {t("Theme editor")}
      </button>

      {open && (
        <>
          <div className="theme-editor-header">
            <input
              className="theme-name-input"
              placeholder={t("Theme name…")}
              aria-label={t("Theme name")}
              value={name}
              onChange={(e) => persistName(e.target.value)}
              spellCheck={false}
            />
            <div className="theme-editor-actions">
              <button type="button"
                className="te-btn"
                onClick={seedFromCurrent}
                title={t("Copy colors from the active theme")}
              >
                {t("Seed from current")}
              </button>
              <button type="button"
                className={`te-btn${previewing ? " te-btn-active" : ""}`}
                onClick={togglePreview}
                title={t("Apply colors temporarily without saving")}
              >
                {previewing ? t("Stop preview") : t("Preview")}
              </button>
              {editing && (
                <button type="button" className="te-btn te-btn-danger" onClick={handleDelete}>
                  {t("Delete")}
                </button>
              )}
              <button type="button"
                className="te-btn te-btn-primary"
                onClick={handleSave}
                disabled={!canSave}
              >
                {editing ? t("Update") : t("Save & apply")}
              </button>
            </div>
          </div>

          {isNameTaken && (
            <p className="theme-editor-error">
              {t('“{name}” is a built-in theme name and cannot be overwritten.', { name })}
            </p>
          )}

           <div className="theme-vars-grid">
            {THEME_VARS.map(({ key, label: fallback, type }) => {
              const label = varLabels[key] ?? fallback;
              return (
              <div key={key} className={`theme-var-row${type === 'text' ? ' theme-var-row--text' : ''}`}>
                <label className="theme-var-label" title={key}>
                  {label}
                </label>
                {key === '--color-bg-editor' ? (
                  <div className="theme-var-inputs">
                    <button type="button"
                      className={`te-btn te-btn-tag${colors[key] === 'dark' ? ' te-btn-active' : ''}`}
                      onClick={() => handleColorChange(key, 'dark')}
                    >{t('Dark')}</button>
                    <button type="button"
                      className={`te-btn te-btn-tag${colors[key] === 'light' ? ' te-btn-active' : ''}`}
                      onClick={() => handleColorChange(key, 'light')}
                    >{t('Light')}</button>
                  </div>
                ) : type === 'text' ? (
                  <div className="theme-var-inputs">
                    <input
                      type="text"
                      className="theme-color-text theme-color-text--wide"
                      aria-label={label}
                      value={colors[key] || ""}
                      onChange={(e) => handleColorChange(key, e.target.value)}
                      spellCheck={false}
                      maxLength={180}
                    />
                  </div>
                ) : (
                  <div className="theme-var-inputs">
                    <input
                      type="color"
                      className="theme-color-swatch"
                      aria-label={t("{label} color picker", { label })}
                      value={colors[key] || "#000000"}
                      onChange={(e) => handleColorChange(key, e.target.value)}
                    />
                    <input
                      type="text"
                      className="theme-color-text"
                      aria-label={t("{label} hex code", { label })}
                      value={colors[key] || ""}
                      onChange={(e) => handleColorChange(key, e.target.value)}
                      spellCheck={false}
                      maxLength={25}
                    />
                  </div>
                )}
              </div>
              );
            })}
          </div>

          <div className="theme-text-panel">
            <div className="theme-text-toolbar">
              <span className="theme-text-label">JSON</span>
              <button type="button" className="te-btn" onClick={handleCopy}>
                {t("Copy")}
              </button>
            </div>
            <textarea
              className="theme-textarea"
              aria-label={t("Theme JSON")}
              value={importText || exportText}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
              rows={14}
            />
            {importText && (
              <div className="theme-import-row">
                <button type="button"
                  className="te-btn te-btn-primary"
                  onClick={handleImport}
                >
                  {t("Import")}
                </button>
                <button type="button"
                  className="te-btn"
                  onClick={() => {
                    setImportText("");
                    setImportError(null);
                  }}
                >
                  {t("Cancel")}
                </button>
                {importError && (
                  <span className="theme-editor-error">{importError}</span>
                )}
              </div>
            )}
          </div>

          <div className="theme-existing">
            <span className="theme-existing-label">{t("Edit existing:")}</span>
            {loadCustomThemes().map((custom) => (
              <button type="button"
                key={custom.name}
                className="te-btn te-btn-tag"
                onClick={() => loadExisting(custom.name)}
              >
                {custom.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── AI assistant (MCP) integration ───────────────────────────────────────────

function McpIntegration() {
  const { t } = useT();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!window.flashback) return;
    window.flashback
      .getMcpConfig()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }, []);

  const handleCopy = () => {
    if (!state.data) return;
    navigator.clipboard.writeText(state.data.json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (state.loading) return <p className="config-hint">{t('Loading…')}</p>;
  if (state.error) return <p className="theme-editor-error">{state.error.message}</p>;

  return (
    <div className="mcp-integration">
      <p className="config-hint">
        {t('Connect an AI assistant to this vault — it can search your notes, draft flashcards from a document, and add them to a deck, right from a conversation. Nothing it changes skips Flashback’s normal save path.')}
      </p>

      <div className="theme-text-panel">
        <div className="theme-text-toolbar">
          <span className="theme-text-label">{t('MCP config')}</span>
          <button type="button" className="te-btn" onClick={handleCopy}>
            {copied ? t('Copied!') : t('Copy')}
          </button>
        </div>
        <textarea
          className="theme-textarea"
          aria-label={t('MCP server configuration JSON')}
          value={state.data?.json ?? ''}
          readOnly
          spellCheck={false}
          rows={8}
        />
      </div>

      <ul className="mcp-instructions">
        <li>
          <strong>Claude Desktop</strong>{' — '}
          <Rich
            text={t('paste this into {file}, then restart Claude Desktop.')}
            values={{ file: <code>%APPDATA%\Claude\claude_desktop_config.json</code> }}
          />
        </li>
        <li>
          <strong>Claude Code</strong>{' — '}
          <Rich
            text={t('save this as {file} in your project, then restart and run {command} to check the connection.')}
            values={{ file: <code>.mcp.json</code>, command: <code>/mcp</code> }}
          />
        </li>
      </ul>

      <p className="config-hint">
        {t('Flashback needs to be running for this to work — since you’re looking at this screen, it already is.')}
      </p>
    </div>
  );
}

// ── About & updates ──────────────────────────────────────────────────────────

// Renders the changing part of the update flow off the 'update-status' IPC stream.
function UpdateStatusLine({ status, onDownload, onInstall, busy }) {
  const { t } = useT();
  switch (status.state) {
    case 'available':
      return (
        <span className="config-update-notice">
          {t('Version {version} is available.', { version: status.version })}
          <button
            type="button"
            className="config-restart-btn config-restart-btn--primary"
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
            className="config-restart-btn config-restart-btn--primary"
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

function AboutUpdates() {
  const { t } = useT();
  const [version, setVersion] = useState(null);
  const [status, setStatus] = useState({ state: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!window.flashback) return;
    window.flashback.getAppVersion?.().then(setVersion).catch(() => {});
    // Background checks (startup + daily) and download progress arrive here too.
    return window.flashback.onUpdateStatus?.((s) => setStatus(s));
  }, []);

  const handleCheck = async () => {
    setBusy(true);
    setStatus({ state: 'checking' });
    const r = await window.flashback.checkForUpdates();
    setBusy(false);
    if (!r.ok) setStatus({ state: r.dev ? 'dev' : 'error', message: r.error });
    else if (!r.version) setStatus({ state: 'none' });
    // When r.version is set, the 'update-available' event already updated status.
  };

  const handleDownload = async () => {
    setBusy(true);
    const r = await window.flashback.downloadUpdate();
    setBusy(false);
    if (!r.ok) setStatus({ state: 'error', message: r.error });
    // Progress + 'downloaded' arrive over the status stream.
  };

  const handleInstall = () => window.flashback.installUpdate();

  if (!window.flashback) {
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
          className="config-restart-btn"
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

// ── SRS study preferences (stored in localStorage) ───────────────────────────

function useSrsPrefs() {
  const [algorithm, setAlgorithmState] = useState(
    () => localStorage.getItem('fb-srs-algorithm') ?? 'sm2',
  );
  const [maxNew, setMaxNewState] = useState(
    () => parseInt(localStorage.getItem('fb-srs-max-new') ?? '20', 10),
  );
  const [retention, setRetentionState] = useState(
    () => Number(localStorage.getItem('fb-fsrs-retention')) || 0.9,
  );
  // Presentation order. Defaults to interleaved: the scheduler picks which cards are due,
  // this picks the order they're shown in.
  const [order, setOrderState] = useState(
    () => localStorage.getItem('fb-trainer-order') ?? 'interleaved',
  );

  const applyAlgorithm = (v) => {
    localStorage.setItem('fb-srs-algorithm', v);
    setAlgorithmState(v);
  };
  const setOrder = (v) => {
    localStorage.setItem('fb-trainer-order', v);
    setOrderState(v);
  };
  const setMaxNew = (v) => {
    const n = Math.max(0, Math.min(200, Number(v) || 0));
    localStorage.setItem('fb-srs-max-new', String(n));
    setMaxNewState(n);
  };
  const setRetention = (v) => {
    const r = Math.max(0.7, Math.min(0.97, Number(v) || 0.9));
    localStorage.setItem('fb-fsrs-retention', String(r));
    setRetentionState(r);
  };

  return { algorithm, applyAlgorithm, maxNew, setMaxNew, retention, setRetention, order, setOrder };
}

// Diary opt-in (stored in localStorage, default off). When on, the Trainer writes a
// per-day summary to the diary on session completion. See DATAMODEL.md § Diary.
function useDiaryPref() {
  const [enabled, setEnabledState] = useState(
    () => localStorage.getItem('fb-diary-enabled') === '1',
  );
  const setEnabled = (v) => {
    localStorage.setItem('fb-diary-enabled', v ? '1' : '0');
    setEnabledState(v);
  };
  return { enabled, setEnabled };
}

// Display name for an algorithm id (used in the picker and migrate prompts).
const ALGO_LABEL = { leitner: 'Leitner', sm2: 'SM-2', fsrs: 'FSRS' };
const algoLabel = (a) => ALGO_LABEL[a] ?? a;

// Per-vault FSRS optimizer panel. Shows how many rated reviews exist, when the
// weights were last fitted, and runs the fit on demand (reporting before/after
// loss). Rendered only while FSRS is the active algorithm.
function FsrsOptimizer() {
  const { t, tp, formatDate } = useT();
  const [info, setInfo] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    getFsrsInfo().then(setInfo).catch(() => setInfo(null));
  };
  useEffect(load, []);

  const enough = info && info.reviewCount >= info.minReviews;

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await optimizeFsrs();
      setResult(res);
      load();
    } catch (e) {
      setError(e?.message ?? t('Optimization failed'));
    } finally {
      setRunning(false);
    }
  };

  const fmtLoss = (n) => (typeof n === 'number' ? n.toFixed(4) : '—');

  return (
    <div className="fsrs-optimizer">
      <p className="config-hint">
        {t('Fit the memory model to your own review history for more accurate scheduling.')}{' '}
        {info != null
          ? t('Needs at least {min} graded reviews — you have {count}.',
            { min: info.minReviews, count: info.reviewCount })
          : t('Needs at least {min} graded reviews.', { min: 400 })}
      </p>

      {info?.optimizedAt && (
        <p className="fsrs-optimizer-status">
          {info.weightReviewCount != null
            ? tp('Last fitted {date} from {n} review.', 'Last fitted {date} from {n} reviews.',
              info.weightReviewCount, { date: formatDate(info.optimizedAt) })
            : t('Last fitted {date}.', { date: formatDate(info.optimizedAt) })}
        </p>
      )}
      {info && !info.optimizedAt && (
        <p className="fsrs-optimizer-status">{t('Using default weights.')}</p>
      )}

      <button
        type="button"
        className="config-restart-btn config-restart-btn--primary"
        onClick={run}
        disabled={running || !enough}
      >
        {running ? t('Optimizing…') : t('Optimize FSRS parameters')}
      </button>

      {result && result.optimized && (
        <p className="fsrs-optimizer-result">
          {tp('Fitted from {n} review.', 'Fitted from {n} reviews.', result.reviewCount)}{' '}
          <Rich
            text={result.loss < result.initialLoss
              ? t('Loss {before} → {after} (improved).')
              : t('Loss {before} → {after} (already near-optimal).')}
            values={{
              before: fmtLoss(result.initialLoss),
              after: <strong>{fmtLoss(result.loss)}</strong>,
            }}
          />
        </p>
      )}
      {result && !result.optimized && (
        <p className="fsrs-optimizer-result">
          {t('Not enough graded reviews yet ({count} of {min}). Keep reviewing and try again later.',
            { count: result.reviewCount, min: result.minReviews })}
        </p>
      )}
      {error && <p className="fsrs-optimizer-error">{error}</p>}
    </div>
  );
}

// ── Main Config view ──────────────────────────────────────────────────────────

export default function ConfigView({
  theme,
  onThemeChange,
  allThemes,
  onCustomThemesChange,
  onReplayTour,
}) {
  const { t } = useT();
  const { config, setConfig, loading, error } = useConfig();
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [restartPending, setRestartPending] = useState(false);
  const { algorithm, applyAlgorithm, maxNew, setMaxNew, retention, setRetention, order, setOrder } = useSrsPrefs();
  const { enabled: diaryEnabled, setEnabled: setDiaryEnabled } = useDiaryPref();

  // Algorithm migration confirm state.
  const [pendingAlgo, setPendingAlgo] = useState(null); // algorithm the user selected but hasn't confirmed
  const [migrating, setMigrating] = useState(false);

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
      } catch { /* non-fatal — still switch */ }
      setMigrating(false);
    }
    applyAlgorithm(to);
  };

  const cancelAlgorithmChange = () => setPendingAlgo(null);

  // Sync form inline when config loads or reloads — avoids a blank-form flash.
  const [prevConfig, setPrevConfig] = useState(config);
  if (prevConfig !== config) {
    setPrevConfig(config);
    if (config) setForm({ ...config });
  }

  const handleChange = (key, value) => {
    setRestartPending(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const RESTART_FIELDS = ['port', 'host', 'logFormat', 'isCustomPath', 'customPath', 'vaultName'];

  const handleSave = async () => {
    setStatus("saving");
    setRestartPending(false);
    const preSave = config;
    const result = await window.flashback.setConfig(form);
    if (result.ok) {
      setConfig(form);
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? null : s)), 2000);
      if (preSave && RESTART_FIELDS.some((k) => form[k] !== preSave[k])) {
        setRestartPending(true);
      }
    } else {
      setStatus(`error: ${result.error}`);
    }
  };

  // Immediately persist the MCP diary-access level to config.json (it's a cross-process
  // authorization boundary the API reads from disk, not a renderer preference — see
  // access/config.getMcpDiaryAccess). One of 'none' | 'summaries' | 'full'. Merges into
  // `form` so the main Save button can't later revert it; setConfig re-syncs form via
  // the inline effect above.
  const setDiaryAccess = async (mode) => {
    if (!form) return;
    const next = { ...form, mcpDiaryAccess: mode };
    const result = await window.flashback.setConfig(next);
    if (result?.ok) setConfig(next);
  };

  // The flag was historically a boolean (true = full, false = none); normalize either
  // shape to the current tri-state for the selector.
  const diaryAccess =
    form?.mcpDiaryAccess === true || form?.mcpDiaryAccess === 'full'
      ? 'full'
      : form?.mcpDiaryAccess === 'summaries'
        ? 'summaries'
        : 'none';

  const isDirty =
    form && config && JSON.stringify(form) !== JSON.stringify(config);

  const hasRestartDirty =
    isDirty && config && form && RESTART_FIELDS.some((k) => form[k] !== config[k]);

  const handleThemeEditorSaved = () => {
    onCustomThemesChange(loadCustomThemes());
  };

  return (
    <div className="config-view">
      <section className="config-section">
        <h2 className="config-heading">{t('Appearance')}</h2>
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
                      {name}
                    </option>
                  ))}
                </select>
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
        <h2 className="config-heading">{t('Flashcards')}</h2>
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
                      <button type="button" className="algo-migrate-btn algo-migrate-btn--primary"
                        onClick={() => confirmMigrate(true)}>
                        {t('Carry over progress')}
                      </button>
                      <button type="button" className="algo-migrate-btn"
                        onClick={() => confirmMigrate(false)}>
                        {t('Start fresh')}
                      </button>
                      <button type="button" className="algo-migrate-btn algo-migrate-btn--cancel"
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
                  {order === 'interleaved' && t('Cards from the same document, tag or folder are pushed apart so each one has to be recalled on its own. Expect sessions to feel harder and your pass rate to dip — that’s the trade for remembering more later.')}
                  {order === 'shuffle' && t('Random order within each category-priority tier.')}
                  {order === 'priority' && t('Foundational cards first, then in the order they were created. Predictable, but reviewing related cards together makes them easier to recall now and harder to recall later.')}
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
        <h2 className="config-heading">{t('Diary')}</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label htmlFor="diary-enabled">{t('Study diary')}</label>
              </td>
              <td>
                <label className="config-checkbox">
                  <input
                    id="diary-enabled"
                    type="checkbox"
                    checked={diaryEnabled}
                    onChange={(e) => setDiaryEnabled(e.target.checked)}
                  />
                  <span>{t('Record a daily summary when a study session finishes')}</span>
                </label>
                <p className="config-hint">
                  {t('Writes a per-day summary of your reviews (counts, pass rate, streak) to a private diary kept outside your workspace — never in the graph, search, or flashcards. You can also add your own written reflections. Off by default.')}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {onReplayTour && (
        <section className="config-section">
          <h2 className="config-heading">{t('Getting started')}</h2>
          <p className="config-hint">
            {t('Take the guided tour of Flashback’s features again — this only replays the walkthrough, it doesn’t touch your vault or settings.')}
          </p>
          <button
            type="button"
            className="config-restart-btn config-restart-btn--primary"
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
          <section className="config-section">
            <h2 className="config-heading">{t('Server')}</h2>
            <table className="config-table">
              <tbody>
                <tr>
                  <td>
                    <label htmlFor="cfg-vault-name">{t('Vault name')}</label>
                  </td>
                  <td>
                    <input
                      id="cfg-vault-name"
                      aria-label={t('Vault name')}
                      placeholder="default"
                      value={form.vaultName ?? ""}
                      onChange={(e) => handleChange("vaultName", e.target.value)}
                    />
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
                <tr>
                  <td>
                    <label htmlFor="cfg-custom-path">{t('Use custom workspace path')}</label>
                  </td>
                  <td>
                    <input
                      id="cfg-custom-path"
                      aria-label={t('Use custom workspace path')}
                      type="checkbox"
                      checked={!!form.isCustomPath}
                      onChange={(e) =>
                        handleChange("isCustomPath", e.target.checked)
                      }
                    />
                  </td>
                </tr>
                {form.isCustomPath && (
                  <tr>
                    <td>
                      <label htmlFor="cfg-workspace-path">{t('Workspace path')}</label>
                    </td>
                    <td>
                      <input
                        id="cfg-workspace-path"
                        aria-label={t('Workspace path')}
                        value={form.customPath ?? ""}
                        onChange={(e) =>
                          handleChange("customPath", e.target.value)
                        }
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="config-save-row">
              <button
                type="button"
                className={[
                  'config-save-btn',
                  isDirty ? 'config-save-btn--dirty' : '',
                  status === 'saved' ? 'config-save-btn--saved' : '',
                ].filter(Boolean).join(' ')}
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
                    className="config-restart-btn config-restart-btn--primary"
                    onClick={() => window.flashback?.restartApp()}
                  >
                    {t('Restart now')}
                  </button>
                  <button
                    type="button"
                    className="config-restart-btn"
                    onClick={() => setRestartPending(false)}
                  >
                    {t('Later')}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="config-section">
            <h2 className="config-heading">{t('AI Assistant')}</h2>
            <McpIntegration />
            <label className="config-checkbox config-checkbox--spaced" htmlFor="diary-access-select">
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
                text={t('Off by default. {summaries} lets an assistant see your machine-generated study record (review counts, pass rates, streaks) while keeping your written reflections private — the right choice if you use the diary as a personal journal. {full} also exposes your own prose. When off, every diary tool is refused.')}
                values={{
                  summaries: <strong>{t('Daily summaries only')}</strong>,
                  full: <strong>{t('Summaries and written entries')}</strong>,
                }}
              />
            </p>
          </section>

          <section className="config-section">
            <h2 className="config-heading">{t('About')}</h2>
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
