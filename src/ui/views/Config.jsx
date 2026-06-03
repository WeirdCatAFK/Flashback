import { useState, useEffect } from "react";
import "./Config.css";
import useFlashcardOrientation from "../hooks/useFlashcardOrientation";
import KeybindingsEditor from "../components/KeybindingsEditor";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!window.flashback) {
      setError(
        new Error(
          "window.flashback not available — run via Electron, not dev:web",
        ),
      );
      setLoading(false);
      return;
    }
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
  "--color-hl-amber":       "#F59E0B",
  "--color-hl-green":       "#10B981",
  "--color-hl-blue":        "#3B82F6",
  "--color-hl-pink":        "#EC4899",
  "--color-review-again":   "#EC4899",
  "--color-review-good":    "#10B981",
  "--color-review-easy":    "#3B82F6",
  "--color-graph-document":  "#F59E0B",
  "--color-graph-folder":    "#A8A29E",
  "--color-graph-flashcard": "#F59E0B",
  "--color-graph-tag":       "#10B981",
  "--color-graph-disconnect":"#EC4899",
  "--color-graph-inherit":   "#3B82F6",
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
        JSON.parse(localStorage.getItem("fb-editor-colors")) ?? DARK_DEFAULTS
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
    localStorage.setItem("fb-editor-colors", JSON.stringify(v));
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
      if (missing.length)
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
      <button className="theme-editor-toggle" onClick={handleToggleOpen}>
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
              value={name}
              onChange={(e) => persistName(e.target.value)}
              spellCheck={false}
            />
            <div className="theme-editor-actions">
              <button
                className="te-btn"
                onClick={seedFromCurrent}
                title="Copy colors from the active theme"
              >
                Seed from current
              </button>
              <button
                className={`te-btn${previewing ? " te-btn-active" : ""}`}
                onClick={togglePreview}
                title="Apply colors temporarily without saving"
              >
                {previewing ? "Stop preview" : "Preview"}
              </button>
              {editing && (
                <button className="te-btn te-btn-danger" onClick={handleDelete}>
                  Delete
                </button>
              )}
              <button
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
              "{name}" is a built-in theme name and cannot be overwritten.
            </p>
          )}

           <div className="theme-vars-grid">
            {THEME_VARS.map(({ key, label }) => (
              <div key={key} className="theme-var-row">
                <label className="theme-var-label" title={key}>
                  {label}
                </label>
                {key === '--color-bg-editor' ? (
                  <div className="theme-var-inputs">
                    <button
                      className={`te-btn te-btn-tag${colors[key] === 'dark' ? ' te-btn-active' : ''}`}
                      onClick={() => handleColorChange(key, 'dark')}
                    >Dark</button>
                    <button
                      className={`te-btn te-btn-tag${colors[key] === 'light' ? ' te-btn-active' : ''}`}
                      onClick={() => handleColorChange(key, 'light')}
                    >Light</button>
                  </div>
                ) : (
                  <div className="theme-var-inputs">
                    <input
                      type="color"
                      className="theme-color-swatch"
                      value={colors[key] || "#000000"}
                      onChange={(e) => handleColorChange(key, e.target.value)}
                    />
                    <input
                      type="text"
                      className="theme-color-text"
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
              <button className="te-btn" onClick={handleCopy}>
                Copy
              </button>
            </div>
            <textarea
              className="theme-textarea"
              value={importText || exportText}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
              rows={14}
            />
            {importText && (
              <div className="theme-import-row">
                <button
                  className="te-btn te-btn-primary"
                  onClick={handleImport}
                >
                  Import
                </button>
                <button
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
              <button
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

// ── SRS study preferences (stored in localStorage) ───────────────────────────

function useSrsPrefs() {
  const [algorithm, setAlgorithmState] = useState(
    () => localStorage.getItem('fb-srs-algorithm') ?? 'leitner',
  );
  const [maxNew, setMaxNewState] = useState(
    () => parseInt(localStorage.getItem('fb-srs-max-new') ?? '20', 10),
  );

  const setAlgorithm = (v) => {
    localStorage.setItem('fb-srs-algorithm', v);
    setAlgorithmState(v);
  };
  const setMaxNew = (v) => {
    const n = Math.max(0, Math.min(200, Number(v) || 0));
    localStorage.setItem('fb-srs-max-new', String(n));
    setMaxNewState(n);
  };

  return { algorithm, setAlgorithm, maxNew, setMaxNew };
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
  const [orientation, setOrientation] = useFlashcardOrientation();
  const { algorithm, setAlgorithm, maxNew, setMaxNew } = useSrsPrefs();

  useEffect(() => {
    if (config) setForm({ ...config });
  }, [config]);

  const handleChange = (key, value) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setStatus("saving");
    const result = await window.flashback.setConfig(form);
    setStatus(result.ok ? "saved" : `error: ${result.error}`);
    if (result.ok) setConfig(form);
  };

  const isDirty =
    form && config && JSON.stringify(form) !== JSON.stringify(config);

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
        <ThemeEditor
          onSaved={handleThemeEditorSaved}
          onThemeChange={onThemeChange}
          currentTheme={theme}
        />
      </section>

      <section className="config-section">
        <h2 className="config-heading">Flashcards</h2>
        <table className="config-table">
          <tbody>
            <tr>
              <td>
                <label htmlFor="flashcard-orientation">Card orientation</label>
              </td>
              <td>
                <select
                  id="flashcard-orientation"
                  value={orientation}
                  onChange={(e) => setOrientation(e.target.value)}
                >
                  <option value="landscape">Landscape (4:3)</option>
                  <option value="portrait">Portrait (3:4)</option>
                </select>
              </td>
            </tr>
            <tr>
              <td>
                <label htmlFor="srs-algorithm">SRS algorithm</label>
              </td>
              <td>
                <select
                  id="srs-algorithm"
                  value={algorithm}
                  onChange={(e) => setAlgorithm(e.target.value)}
                >
                  <option value="leitner">Leitner (doubles each level)</option>
                  <option value="sm2">SM-2 (ease factor)</option>
                </select>
              </td>
            </tr>
            <tr>
              <td>
                <label htmlFor="srs-max-new">New cards per day</label>
              </td>
              <td>
                <input
                  id="srs-max-new"
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
        <KeybindingsEditor />
      </section>

      <section className="config-section">
        <h2 className="config-heading">Server</h2>

        {loading && <p>Loading config…</p>}
        {error && <p>Error: {error.message}</p>}

        {form && (
          <>
            <table className="config-table">
              <tbody>
                <tr>
                  <td>
                    <label>Username</label>
                  </td>
                  <td>
                    <input
                      value={form.username ?? ""}
                      onChange={(e) => handleChange("username", e.target.value)}
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Port</label>
                  </td>
                  <td>
                    <input
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
                    <label>Host</label>
                  </td>
                  <td>
                    <input
                      value={form.host ?? "localhost"}
                      onChange={(e) => handleChange("host", e.target.value)}
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Custom workspace path</label>
                  </td>
                  <td>
                    <input
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
                      <label>Workspace path</label>
                    </td>
                    <td>
                      <input
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

            <p className="config-save-row">
              <button
                onClick={handleSave}
                disabled={!isDirty || status === "saving"}
              >
                Save
              </button>
              {status && <span className="config-status">{status}</span>}
            </p>

            {isDirty && (
              <p className="config-hint">
                ⚠ Restart the app for port / host / path changes to take effect.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
