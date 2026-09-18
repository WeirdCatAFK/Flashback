/**
 * The explorer's dialogs: a folder's colour swatch, a folder's tags (direct,
 * inherited, excluded), and capturing a web page or a YouTube video into a
 * folder. All three are Modal dialogs.
 */

import { useState, useEffect } from "react";
import {
  getEntityTags,
  getTags,
  getSidecar,
  updateMetadata,
  clipUrl,
  clipYoutube,
} from "../../../api/documents";
import Modal from "../../base/Modal";
import TagChipInput from "../../base/TagChipInput";
import { useT } from "../../../translations/index";
import { looksLikeYoutube } from "./names.js";

const SWATCH_PRESETS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export function FolderSwatchModal({ path, currentColor, onClose, onSaved }) {
  const { t } = useT();
  const [custom, setCustom] = useState(currentColor || "#3b82f6");
  const [saving, setSaving] = useState(false);

  const apply = async (color) => {
    setSaving(true);
    try {
      const sidecar = await getSidecar(path, true);
      await updateMetadata(
        path,
        { ...(sidecar || {}), swatchColor: color },
        true,
      );
      onSaved();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Modal title={t("Folder color")} size="sm" onClose={onClose}>
      <div className="fsm-swatches">
        <button
          type="button"
          className={`fsm-swatch fsm-swatch--none${!currentColor ? " fsm-swatch--active" : ""}`}
          title={t("No color")}
          disabled={saving}
          onClick={() => apply("")}
        />
        {SWATCH_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            className={`fsm-swatch${currentColor === c ? " fsm-swatch--active" : ""}`}
            style={{ background: c }}
            title={c}
            disabled={saving}
            onClick={() => apply(c)}
          />
        ))}
      </div>
      <div className="fsm-custom-row">
        <span className="fsm-custom-label">{t("Custom")}</span>
        <input
          type="color"
          className="fsm-custom-input"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={saving}
          onClick={() => apply(custom)}
        >
          {t("Apply")}
        </button>
      </div>
    </Modal>
  );
}

export function FolderTagsModal({ path, onClose }) {
  const { t } = useT();
  const [inherited, setInherited] = useState([]);
  const [directTags, setDirectTags] = useState([]);
  const [excludedTags, setExcludedTags] = useState([]);
  const [allKnownTags, setAllKnownTags] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    Promise.all([getEntityTags(path, true), getTags()])
      .then(([entity, { tags: all }]) => {
        if (cancelled) return;
        setInherited(entity.inherited ?? []);
        setDirectTags(entity.direct ?? []);
        setExcludedTags(entity.excluded ?? []);
        setAllKnownTags(all ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  const edit = (setter) => (fn) => {
    setter(fn);
    setDirty(true);
  };
  const editDirect = edit(setDirectTags);
  const editExcluded = edit(setExcludedTags);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const sidecar = await getSidecar(path, true);
      await updateMetadata(
        path,
        { ...sidecar, tags: directTags, excludedTags },
        true,
      );
      onClose();
    } catch {
      setError(t("Save failed."));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("Folder tags")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
        </>
      }
    >
      <p className="muted ftm-path">{path}</p>
      {inherited.length > 0 && (
        <div className="ftm-section">
          <div className="eyebrow ftm-label">
            {t("Inherited")}{" "}
            <span className="ftm-hint">
              {t("from parent folders, read-only")}
            </span>
          </div>
          <div className="tags-chip-row">
            {inherited.map((tag) => (
              <span key={tag} className="tag-chip tag-chip--inherited">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="ftm-section">
        <div className="eyebrow ftm-label">{t("Direct tags")}</div>
        <TagChipInput
          tags={directTags}
          onAdd={(tag) =>
            editDirect((p) => (p.includes(tag) ? p : [...p, tag]))
          }
          onRemove={(tag) => editDirect((p) => p.filter((x) => x !== tag))}
          allKnownTags={allKnownTags}
          chipClass="tag-chip--direct"
        />
      </div>
      <div className="ftm-section">
        <div className="eyebrow ftm-label">
          {t("Excluded tags")}{" "}
          <span className="ftm-hint">
            {t("block these inherited tags from propagating to children")}
          </span>
        </div>
        <TagChipInput
          tags={excludedTags}
          onAdd={(tag) =>
            editExcluded((p) => (p.includes(tag) ? p : [...p, tag]))
          }
          onRemove={(tag) => editExcluded((p) => p.filter((x) => x !== tag))}
          allKnownTags={[...inherited, ...directTags]}
          placeholder={t("Add exclusion…")}
          chipClass="tag-chip--excluded"
        />
      </div>
      {error && <p className="ftm-error">{error}</p>}
    </Modal>
  );
}

/** Captures a web article (.clip) or a YouTube reference (.youtube); the kind auto-detects from the host. */
export function ClipUrlModal({ targetPath, onClose, onCreated }) {
  const { t } = useT();
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const effectiveKind =
    kind === "auto" ? (looksLikeYoutube(url) ? "youtube" : "article") : kind;

  const submit = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        effectiveKind === "youtube"
          ? await clipYoutube(u, targetPath)
          : await clipUrl(u, targetPath);
      onCreated(result?.path);
    } catch (err) {
      setError(err?.message || t("Could not capture that URL."));
      setBusy(false);
    }
  };

  const hint =
    kind === "auto"
      ? effectiveKind === "youtube"
        ? t("Auto-detected: YouTube video.")
        : t("Auto-detected: web article.")
      : effectiveKind === "youtube"
        ? t("Stores the video reference with timestamp highlights.")
        : t("Fetches and stores a readable snapshot of the page.");

  return (
    <Modal
      title={t("Clip from URL")}
      size="sm"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={busy || !url.trim()}
          >
            {busy ? t("Clipping…") : t("Clip")}
          </button>
        </>
      }
    >
      <div className="clip-form">
        <label className="clip-field">
          <span className="eyebrow">{t("Page or video URL")}</span>
          <input
            className="field"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            autoFocus
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div
          className="clip-kind"
          role="radiogroup"
          aria-label={t("Capture as")}
        >
          {[
            ["auto", t("Auto")],
            ["article", t("Article")],
            ["youtube", t("YouTube")],
          ].map(([val, lbl]) => (
            <button
              key={val}
              type="button"
              role="radio"
              aria-checked={kind === val}
              className={`btn btn--sm${kind === val ? " btn--accent-quiet" : ""}`}
              disabled={busy}
              onClick={() => setKind(val)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <p className="muted">{hint}</p>
        {error && <p className="clip-error">{error}</p>}
      </div>
    </Modal>
  );
}
