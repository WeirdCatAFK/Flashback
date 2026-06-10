import { useState, useEffect, useCallback, useRef } from 'react';
import { getTags, getEntityTags } from '../../../api/documents';

function TagChipInput({ tags, onAdd, onRemove, allKnownTags = [], placeholder = 'Add tag…', chipClass = '' }) {
  const [input, setInput] = useState('');
  const [open, setOpen]   = useState(false);
  const inputRef          = useRef(null);

  const suggestions = input.trim()
    ? allKnownTags.filter(t =>
        t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)
      ).slice(0, 8)
    : allKnownTags.filter(t => !tags.includes(t)).slice(0, 8);

  const addTag = useCallback((name) => {
    const t = name.trim();
    if (t && !tags.includes(t)) onAdd(t);
    setInput('');
    setOpen(false);
  }, [tags, onAdd]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter')     { e.preventDefault(); if (input.trim()) addTag(input); }
    if (e.key === 'Escape')    { setOpen(false); setInput(''); }
    if (e.key === 'Backspace' && !input && tags.length > 0) onRemove(tags[tags.length - 1]);
  };

  return (
    <div className="tci-wrap">
      <div className={`tci-row${open && suggestions.length > 0 ? ' tci-row--open' : ''}`}>
        {tags.map(t => (
          <span key={t} className={`tag-chip ${chipClass}`}>
            {t}
            <button type="button" className="tag-chip-remove" onClick={() => onRemove(t)} aria-label={`Remove ${t}`}>×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tci-input"
          value={input}
          placeholder={tags.length === 0 ? placeholder : ''}
          onChange={e => { setInput(e.target.value); setOpen(true); }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul className="tci-dropdown">
          {suggestions.map(s => (
            <li key={s} className="tci-suggestion" onMouseDown={() => addTag(s)}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function InspectorTagsTab({ path, tags: propTags = [], onTagsChange }) {
  const [directTags, setDirectTags]     = useState(propTags);
  const [inheritedTags, setInheritedTags] = useState([]);
  const [allKnownTags, setAllKnownTags] = useState([]);
  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  // Sync direct tags when parent refreshes the sidecar (e.g. after save)
  useEffect(() => {
    setDirectTags(propTags);
    setDirty(false);
  }, [JSON.stringify(propTags), path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch inherited tags + all known tags whenever the active file changes
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    Promise.all([getEntityTags(path, false), getTags()])
      .then(([entity, { tags: all }]) => {
        if (cancelled) return;
        setInheritedTags(entity.inherited ?? []);
        setAllKnownTags(all ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  const addTag = useCallback((name) => {
    setDirectTags(prev => prev.includes(name) ? prev : [...prev, name]);
    setDirty(true);
    setError(null);
  }, []);

  const removeTag = useCallback((name) => {
    setDirectTags(prev => prev.filter(t => t !== name));
    setDirty(true);
    setError(null);
  }, []);

  const handleSave = async () => {
    if (!onTagsChange) return;
    setSaving(true);
    setError(null);
    try {
      await onTagsChange(directTags, []);
      setDirty(false);
      // Re-fetch inherited after propagation may have updated them
      const entity = await getEntityTags(path, false);
      setInheritedTags(entity.inherited ?? []);
    } catch (err) {
      setError('Save failed. Please try again.');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDirectTags(propTags);
    setDirty(false);
    setError(null);
  };

  if (!path) return <div className="inspector-placeholder"><p>No file open.</p></div>;

  return (
    <div className="tags-tab">
      {inheritedTags.length > 0 && (
        <div className="tags-section">
          <div className="tags-section-label">
            Inherited
            <span className="tags-section-hint">from parent folders</span>
          </div>
          <div className="tags-chip-row">
            {inheritedTags.map(t => (
              <span key={t} className="tag-chip tag-chip--inherited">{t}</span>
            ))}
          </div>
        </div>
      )}

      <div className="tags-section">
        <div className="tags-section-label">Direct tags</div>
        <TagChipInput
          tags={directTags}
          onAdd={addTag}
          onRemove={removeTag}
          allKnownTags={allKnownTags}
          placeholder="Add tag…"
          chipClass="tag-chip--direct"
        />
      </div>

      {error && <p className="tags-error">{error}</p>}

      {dirty && (
        <div className="tags-actions">
          <button type="button" className="tags-btn tags-btn--ghost" onClick={handleDiscard}>Discard</button>
          <button type="button" className="tags-btn tags-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {!dirty && directTags.length === 0 && inheritedTags.length === 0 && (
        <p className="inspector-placeholder" style={{ marginTop: 12 }}>
          No tags yet. Add a direct tag above, or assign tags to a parent folder.
        </p>
      )}
    </div>
  );
}
