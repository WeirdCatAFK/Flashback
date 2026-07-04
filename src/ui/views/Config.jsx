import { useState, useEffect, useCallback } from "react";
import "./Config.css";
import KeybindingsEditor from "../components/KeybindingsEditor";
import ProgressDialog from "../components/shared/ProgressDialog";
import { migrateProgress } from "../api/srs";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../api/categories";
import { THEMES } from "../themes";
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
  "--color-tree-indent":    "#2C2420",
  "--color-hl-1":           "#F59E0B",
  "--color-hl-2":           "#10B981",
  "--color-hl-3":           "#3B82F6",
  "--color-hl-4":           "#EC4899",
  "--color-review-again":   "#EC4899",
  "--color-review-good":    "#10B981",
  "--color-review-easy":    "#3B82F6",
  "--color-graph-document":  "#F59E0B",
  "--color-graph-folder":    "#A8A29E",
  "--color-graph-flashcard": "#F59E0B",
  "--color-graph-tag":       "#10B981",
  "--color-graph-deck":      "#8B5CF6",
  "--color-graph-disconnect":"#EC4899",
  "--color-graph-inherit":   "#3B82F6",
  "--color-danger":          "#F87171",
  "--color-danger-bg":       "rgba(248, 113, 113, 0.12)",
  "--shadow-float":          "0 6px 24px -2px rgba(0,0,0,.50), 0 2px 8px rgba(0,0,0,.22)",
};

const PREVIEW_THEME = "__fb_preview__";

function ThemeEditor({ onSaved, onThemeChange, currentTheme }) {
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
    const found = all.find((t) => t.name === themeName);
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
        throw new Error('Missing or invalid "name" field.');
      if (typeof parsed.colors !== "object" || parsed.colors === null)
        throw new Error('Missing or invalid "colors" field.');
      const missing = THEME_VARS.filter(({ key }) => !(key in parsed.colors));
      if (missing.length > THEME_VARS.length / 2)
        throw new Error(
          `Missing variables: ${missing.map((v) => v.key).join(", ")}`,
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
        Theme editor
      </button>

      {open && (
        <>
          <div className="theme-editor-header">
            <input
              className="theme-name-input"
              placeholder="Theme name…"
              aria-label="Theme name"
              value={name}
              onChange={(e) => persistName(e.target.value)}
              spellCheck={false}
            />
            <div className="theme-editor-actions">
              <button type="button"
                className="te-btn"
                onClick={seedFromCurrent}
                title="Copy colors from the active theme"
              >
                Seed from current
              </button>
              <button type="button"
                className={`te-btn${previewing ? " te-btn-active" : ""}`}
                onClick={togglePreview}
                title="Apply colors temporarily without saving"
              >
                {previewing ? "Stop preview" : "Preview"}
              </button>
              {editing && (
                <button type="button" className="te-btn te-btn-danger" onClick={handleDelete}>
                  Delete
                </button>
              )}
              <button type="button"
                className="te-btn te-btn-primary"
                onClick={handleSave}
                disabled={!canSave}
              >
                {editing ? "Update" : "Save & apply"}
              </button>
            </div>
          </div>

          {isNameTaken && (
            <p className="theme-editor-error">
              &ldquo;{name}&rdquo; is a built-in theme name and cannot be overwritten.
            </p>
          )}

           <div className="theme-vars-grid">
            {THEME_VARS.map(({ key, label, type }) => (
              <div key={key} className={`theme-var-row${type === 'text' ? ' theme-var-row--text' : ''}`}>
                <label className="theme-var-label" title={key}>
                  {label}
                </label>
                {key === '--color-bg-editor' ? (
                  <div className="theme-var-inputs">
                    <button type="button"
                      className={`te-btn te-btn-tag${colors[key] === 'dark' ? ' te-btn-active' : ''}`}
                      onClick={() => handleColorChange(key, 'dark')}
                    >Dark</button>
                    <button type="button"
                      className={`te-btn te-btn-tag${colors[key] === 'light' ? ' te-btn-active' : ''}`}
                      onClick={() => handleColorChange(key, 'light')}
                    >Light</button>
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
                      aria-label={`${label} color picker`}
                      value={colors[key] || "#000000"}
                      onChange={(e) => handleColorChange(key, e.target.value)}
                    />
                    <input
                      type="text"
                      className="theme-color-text"
                      aria-label={`${label} hex code`}
                      value={colors[key] || ""}
                      onChange={(e) => handleColorChange(key, e.target.value)}
                      spellCheck={false}
                      maxLength={25}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="theme-text-panel">
            <div className="theme-text-toolbar">
              <span className="theme-text-label">JSON</span>
              <button type="button" className="te-btn" onClick={handleCopy}>
                Copy
              </button>
            </div>
            <textarea
              className="theme-textarea"
              aria-label="Theme JSON"
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
                  Import
                </button>
                <button type="button"
                  className="te-btn"
                  onClick={() => {
                    setImportText("");
                    setImportError(null);
                  }}
                >
                  Cancel
                </button>
                {importError && (
                  <span className="theme-editor-error">{importError}</span>
                )}
              </div>
            )}
          </div>

          <div className="theme-existing">
            <span className="theme-existing-label">Edit existing:</span>
            {loadCustomThemes().map((t) => (
              <button type="button"
                key={t.name}
                className="te-btn te-btn-tag"
                onClick={() => loadExisting(t.name)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Pedagogical categories editor ────────────────────────────────────────────

function CategoryRow({ cat, onSave, onDelete }) {
  const [name, setName] = useState(cat.name);
  const [priority, setPriority] = useState(cat.priority);
  const [description, setDescription] = useState(cat.description ?? '');

  useEffect(() => { setName(cat.name); }, [cat.name]);
  useEffect(() => { setPriority(cat.priority); }, [cat.priority]);
  useEffect(() => { setDescription(cat.description ?? ''); }, [cat.description]);

  return (
    <tr className="cat-row">
      <td>
        <input
          type="number"
          className="cat-input cat-input--priority"
          value={priority}
          min={0}
          max={99}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={() => onSave(cat.id, { priority: Number(priority) })}
          aria-label="Priority"
        />
      </td>
      <td>
        <input
          type="text"
          className="cat-input cat-input--name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onSave(cat.id, { name })}
          aria-label="Category name"
          maxLength={200}
        />
      </td>
      <td>
        <input
          type="text"
          className="cat-input cat-input--desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => onSave(cat.id, { description })}
          aria-label="Description"
          maxLength={500}
        />
      </td>
      <td>
        <button
          type="button"
          className="te-btn te-btn-danger cat-delete-btn"
          onClick={() => onDelete(cat.id)}
          title="Delete category"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

function CategoriesEditor() {
  const [open, setOpen] = useState(() => localStorage.getItem('fb-categories-open') === 'true');
  const [draft, setDraft] = useState({ name: '', priority: 0, description: '' });
  const [categories, setCategories] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setIsLoading(true);
    getCategories()
      .then(setCategories)
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const handleToggle = () => {
    setOpen((o) => {
      localStorage.setItem('fb-categories-open', String(!o));
      return !o;
    });
  };

  const handleSave = (id, data) => {
    if (data.name !== undefined && !data.name.trim()) return;
    updateCategory(id, data).then(reload);
  };

  const handleDelete = (id) => {
    setDeleteError(null);
    deleteCategory(id).then(reload).catch((err) => setDeleteError(err.message));
  };

  const handleAdd = () => {
    if (!draft.name.trim()) return;
    setAdding(true);
    createCategory({
      name: draft.name.trim(),
      priority: Number(draft.priority) || 0,
      description: draft.description,
    })
      .then(() => {
        setDraft({ name: '', priority: 0, description: '' });
        reload();
      })
      .finally(() => setAdding(false));
  };

  return (
    <div className="categories-editor">
      <button type="button" className="theme-editor-toggle" onClick={handleToggle}>
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
        Pedagogical categories
      </button>

      {open && (
        <>
          {isLoading ? (
            <p className="config-hint">Loading…</p>
          ) : (
            <table className="cat-table">
              <thead>
                <tr>
                  <th className="cat-th cat-th--priority">Priority</th>
                  <th className="cat-th">Name</th>
                  <th className="cat-th">Description</th>
                  <th className="cat-th" />
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <CategoryRow
                    key={cat.id}
                    cat={cat}
                    onSave={handleSave}
                    onDelete={handleDelete}
                  />
                ))}
                <tr className="cat-row cat-add-row">
                  <td>
                    <input
                      type="number"
                      className="cat-input cat-input--priority"
                      value={draft.priority}
                      min={0}
                      max={99}
                      onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                      aria-label="New category priority"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="cat-input cat-input--name"
                      placeholder="Name…"
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                      aria-label="New category name"
                      maxLength={200}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="cat-input cat-input--desc"
                      placeholder="Description…"
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                      aria-label="New category description"
                      maxLength={500}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="te-btn te-btn-primary"
                      onClick={handleAdd}
                      disabled={!draft.name.trim() || adding}
                    >
                      Add
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {deleteError && (
            <p className="theme-editor-error">{deleteError}</p>
          )}
          <p className="config-hint">
            Lower priority = studied first in a session. Cards with no category are treated as priority 0.
          </p>
        </>
      )}
    </div>
  );
}

// ── AI assistant (MCP) integration ───────────────────────────────────────────

function McpIntegration() {
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

  if (state.loading) return <p className="config-hint">Loading…</p>;
  if (state.error) return <p className="theme-editor-error">{state.error.message}</p>;

  return (
    <div className="mcp-integration">
      <p className="config-hint">
        Connect an AI assistant to this vault — it can search your notes, draft flashcards from a
        document, and add them to a deck, right from a conversation. Nothing it changes skips
        Flashback&rsquo;s normal save path.
      </p>

      <div className="theme-text-panel">
        <div className="theme-text-toolbar">
          <span className="theme-text-label">MCP config</span>
          <button type="button" className="te-btn" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <textarea
          className="theme-textarea"
          aria-label="MCP server configuration JSON"
          value={state.data?.json ?? ''}
          readOnly
          spellCheck={false}
          rows={8}
        />
      </div>

      <ul className="mcp-instructions">
        <li>
          <strong>Claude Desktop</strong> — paste this into{' '}
          <code>%APPDATA%\Claude\claude_desktop_config.json</code>, then restart Claude Desktop.
        </li>
        <li>
          <strong>Claude Code</strong> — save this as <code>.mcp.json</code> in your project, then
          restart and run <code>/mcp</code> to check the connection.
        </li>
      </ul>

      <p className="config-hint">
        Flashback needs to be running for this to work — since you&rsquo;re looking at this screen, it
        already is.
      </p>
    </div>
  );
}

// ── About & updates ──────────────────────────────────────────────────────────

// Renders the changing part of the update flow off the 'update-status' IPC stream.
function UpdateStatusLine({ status, onDownload, onInstall, busy }) {
  switch (status.state) {
    case 'available':
      return (
        <span className="config-update-notice">
          Version {status.version} is available.
          <button
            type="button"
            className="config-restart-btn config-restart-btn--primary"
            onClick={onDownload}
            disabled={busy}
          >
            Update now
          </button>
        </span>
      );
    case 'downloading':
      return <span className="config-status">Downloading… {status.percent ?? 0}%</span>;
    case 'downloaded':
      return (
        <span className="config-update-notice">
          Version {status.version} is ready to install.
          <button
            type="button"
            className="config-restart-btn config-restart-btn--primary"
            onClick={onInstall}
          >
            Restart &amp; install
          </button>
        </span>
      );
    case 'none':
      return <span className="config-status">You&rsquo;re up to date.</span>;
    case 'dev':
      return <span className="config-hint">Updates are only available in the packaged app.</span>;
    case 'error':
      return (
        <span className="config-status config-status--error">
          {status.message || 'Update check failed.'}
        </span>
      );
    default:
      return null;
  }
}

function AboutUpdates() {
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
    return <p className="config-hint">Version and updates are available in the desktop app.</p>;
  }

  return (
    <div className="config-about">
      <table className="config-table">
        <tbody>
          <tr>
            <td><label>Version</label></td>
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
          {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
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
    () => localStorage.getItem('fb-srs-algorithm') ?? 'leitner',
  );
  const [maxNew, setMaxNewState] = useState(
    () => parseInt(localStorage.getItem('fb-srs-max-new') ?? '20', 10),
  );

  const applyAlgorithm = (v) => {
    localStorage.setItem('fb-srs-algorithm', v);
    setAlgorithmState(v);
  };
  const setMaxNew = (v) => {
    const n = Math.max(0, Math.min(200, Number(v) || 0));
    localStorage.setItem('fb-srs-max-new', String(n));
    setMaxNewState(n);
  };

  return { algorithm, applyAlgorithm, maxNew, setMaxNew };
}

// ── Main Config view ──────────────────────────────────────────────────────────

export default function ConfigView({
  theme,
  onThemeChange,
  allThemes,
  onCustomThemesChange,
}) {
  const { config, setConfig, loading, error } = useConfig();
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [restartPending, setRestartPending] = useState(false);
  const { algorithm, applyAlgorithm, maxNew, setMaxNew } = useSrsPrefs();

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
        <h2 className="config-heading">Appearance</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label htmlFor="theme-select">Theme</label>
              </td>
              <td>
                <select
                  id="theme-select"
                  value={theme ?? "light-workbench"}
                  onChange={(e) => onThemeChange(e.target.value)}
                >
                  {allThemes.map((t) => (
                    <option key={t} value={t}>
                      {t}
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
        <h2 className="config-heading">Flashcards</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label htmlFor="srs-algorithm">SRS algorithm</label>
              </td>
              <td>
                <select
                  id="srs-algorithm"
                  value={pendingAlgo ?? algorithm}
                  onChange={(e) => handleAlgorithmSelect(e.target.value)}
                >
                  <option value="leitner">Leitner (doubles each level)</option>
                  <option value="sm2">SM-2 (ease factor)</option>
                </select>
              </td>
            </tr>
            {pendingAlgo && (
              <tr>
                <td colSpan={2}>
                  <div className="algo-migrate-confirm">
                    <p className="algo-migrate-msg">
                      Switch to <strong>{pendingAlgo === 'sm2' ? 'SM-2' : 'Leitner'}</strong>?
                    </p>
                    <div className="algo-migrate-actions">
                      <button type="button" className="algo-migrate-btn algo-migrate-btn--primary"
                        onClick={() => confirmMigrate(true)}>
                        Carry over progress
                      </button>
                      <button type="button" className="algo-migrate-btn"
                        onClick={() => confirmMigrate(false)}>
                        Start fresh
                      </button>
                      <button type="button" className="algo-migrate-btn algo-migrate-btn--cancel"
                        onClick={cancelAlgorithmChange}>
                        Cancel
                      </button>
                    </div>
                    <p className="algo-migrate-hint">
                      Carry over maps each card&rsquo;s current interval to the nearest equivalent in {pendingAlgo === 'sm2' ? 'SM-2' : 'Leitner'}.
                    </p>
                  </div>
                </td>
              </tr>
            )}
            <tr>
              <td>
                <label htmlFor="srs-max-new">New cards per day</label>
              </td>
              <td>
                <input
                  id="srs-max-new"
                  aria-label="New cards per day"
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
        <div className="config-collapsibles">
          <CategoriesEditor />
        </div>
      </section>

      {loading && <p>Loading config…</p>}
      {error && <p>Error: {error.message}</p>}

      {form && (
        <>
          <section className="config-section">
            <h2 className="config-heading">Server</h2>
            <table className="config-table">
              <tbody>
                <tr>
                  <td>
                    <label htmlFor="cfg-vault-name">Vault name</label>
                  </td>
                  <td>
                    <input
                      id="cfg-vault-name"
                      aria-label="Vault name"
                      placeholder="default"
                      value={form.vaultName ?? ""}
                      onChange={(e) => handleChange("vaultName", e.target.value)}
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label htmlFor="cfg-port">Port</label>
                  </td>
                  <td>
                    <input
                      id="cfg-port"
                      aria-label="Port"
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
                    <label htmlFor="cfg-host">Host</label>
                  </td>
                  <td>
                    <input
                      id="cfg-host"
                      aria-label="Host"
                      value={form.host ?? "localhost"}
                      onChange={(e) => handleChange("host", e.target.value)}
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label htmlFor="cfg-log-format">Log format</label>
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
                    <label htmlFor="cfg-custom-path">Use custom workspace path</label>
                  </td>
                  <td>
                    <input
                      id="cfg-custom-path"
                      aria-label="Use custom workspace path"
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
                      <label htmlFor="cfg-workspace-path">Workspace path</label>
                    </td>
                    <td>
                      <input
                        id="cfg-workspace-path"
                        aria-label="Workspace path"
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
                {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save changes'}
              </button>
              {isDirty && (
                <span className="config-unsaved-indicator">
                  <span className="config-unsaved-dot" />
                  Unsaved changes
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
                ⚠ Changes to vault name, port, host, log format, or workspace path require a restart to take effect.
              </p>
            )}

            {restartPending && (
              <div className="config-restart-prompt">
                <span className="config-restart-message">
                  Server settings changed — restart to apply.
                </span>
                <div className="config-restart-actions">
                  <button
                    type="button"
                    className="config-restart-btn config-restart-btn--primary"
                    onClick={() => window.flashback?.restartApp()}
                  >
                    Restart now
                  </button>
                  <button
                    type="button"
                    className="config-restart-btn"
                    onClick={() => setRestartPending(false)}
                  >
                    Later
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="config-section">
            <h2 className="config-heading">AI Assistant</h2>
            <McpIntegration />
          </section>

          <section className="config-section">
            <h2 className="config-heading">About</h2>
            <AboutUpdates />
          </section>
        </>
      )}

      {migrating && (
        <ProgressDialog
          title="Translating progress…"
          statusText="Mapping intervals to the new algorithm"
          progress={0}
          processing
        />
      )}
    </div>
  );
}
