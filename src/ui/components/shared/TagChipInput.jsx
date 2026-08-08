/**
 * TagChipInput — chips + type-ahead tag entry. This was copy-pasted near-identically
 * in FileExplorer and the inspector's Tags tab; this is the single shared version.
 * Relies on the `.tci-*` / `.tag-chip` classes shipped by its consumers' stylesheets.
 *
 *   <TagChipInput tags={tags} onAdd={add} onRemove={remove} allKnownTags={all} />
 */

import { useState, useCallback, useRef } from 'react';
import { useT } from '../../translations';

export default function TagChipInput({
  tags,
  onAdd,
  onRemove,
  allKnownTags = [],
  placeholder,
  chipClass = '',
}) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const { t } = useT();

  const suggestions = input.trim()
    ? allKnownTags.filter(tag => tag.toLowerCase().includes(input.toLowerCase()) && !tags.includes(tag)).slice(0, 8)
    : allKnownTags.filter(tag => !tags.includes(tag)).slice(0, 8);

  const addTag = useCallback((name) => {
    const trimmed = name.trim();
    if (trimmed && !tags.includes(trimmed)) onAdd(trimmed);
    setInput('');
    setOpen(false);
  }, [tags, onAdd]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (input.trim()) addTag(input); }
    if (e.key === 'Escape') { setOpen(false); setInput(''); }
    if (e.key === 'Backspace' && !input && tags.length > 0) onRemove(tags[tags.length - 1]);
  };

  return (
    <div className="tci-wrap">
      <div className={`tci-row${open && suggestions.length > 0 ? ' tci-row--open' : ''}`}>
        {tags.map(tag => (
          <span key={tag} className={`tag-chip ${chipClass}`}>
            {tag}
            <button type="button" className="tag-chip-remove" onClick={() => onRemove(tag)} aria-label={t('Remove {tag}', { tag })}>×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tci-input"
          value={input}
          placeholder={tags.length === 0 ? (placeholder ?? t('Add tag…')) : ''}
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
