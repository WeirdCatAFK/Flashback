import { useState } from 'react';
import { readFile, updateMetadata } from '../../../api/documents';

const CATEGORIES = ['Definition', 'Concept', 'Exercise', 'Formula', 'Fact', 'Pitfall'];

export default function InspectorNewCardTab({ path, selection, highlightId, onCancel, onSaved }) {
  const [front, setFront]       = useState('');
  const [back, setBack]         = useState('');
  const [tags, setTags]         = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [category, setCategory] = useState('Concept');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags(prev => [...prev, t]);
    setTagInput('');
  };

  const removeTag = (tag) => setTags(prev => prev.filter(t => t !== tag));

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
  };

  const handleSave = async () => {
    if (!front.trim() || !back.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // Metadata-only write — never rewrites the document body, so unsaved
      // editor edits and the inline <mark> anchors are left untouched.
      const { metadata } = await readFile(path);
      const newCard = {
        name: front.trim(),
        globalHash: null,
        lastRecall: null,
        level: 0,
        presence: 0,
        tags,
        category,
        isCustom: false,
        customData: { html: '' },
        vanillaData: {
          frontText: front.trim(),
          backText: back.trim(),
          media: { front_img: null, back_img: null, front_sound: null, back_sound: null },
          location: highlightId ? { type: 'highlight', id: highlightId } : null,
        },
      };
      const updatedMeta = {
        ...metadata,
        flashcards: [...(metadata?.flashcards ?? []), newCard],
      };
      await updateMetadata(path, updatedMeta);
      onSaved();
    } catch (err) {
      setError(err.message ?? 'Failed to save card');
    } finally {
      setSaving(false);
    }
  };

  const filename = path?.replace(/\\/g, '/').split('/').pop() ?? '';

  return (
    <div className="new-card-tab">
      {selection?.text && (
        <div className="new-card-selection">
          <p className="new-card-selected-text">"{selection.text}"</p>
          <span className="new-card-source">{highlightId ? 'highlight' : 'unanchored'} · {filename}</span>
        </div>
      )}

      <label className="new-card-label">FRONT</label>
      <textarea
        className="new-card-field"
        value={front}
        onChange={e => setFront(e.target.value)}
        rows={3}
        placeholder="Question or prompt…"
      />

      <label className="new-card-label">BACK</label>
      <textarea
        className="new-card-field"
        value={back}
        onChange={e => setBack(e.target.value)}
        rows={3}
        placeholder="Answer…"
      />

      <label className="new-card-label">TAGS</label>
      <div className="new-card-tags">
        {tags.map(tag => (
          <span key={tag} className="card-tag card-tag--removable">
            {tag}
            <button className="card-tag-remove" onClick={() => removeTag(tag)}>×</button>
          </span>
        ))}
        <input
          className="new-card-tag-input"
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={handleTagKeyDown}
          onBlur={addTag}
          placeholder="+ tag"
        />
      </div>

      <label className="new-card-label">PEDAGOGICAL CATEGORY</label>
      <select
        className="new-card-select"
        value={category}
        onChange={e => setCategory(e.target.value)}
      >
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      {error && <p className="new-card-error">{error}</p>}

      <div className="new-card-actions">
        <button
          className="new-card-save"
          onClick={handleSave}
          disabled={saving || !front.trim() || !back.trim()}
        >
          {saving ? 'Saving…' : 'Save card'}
        </button>
        <button className="new-card-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
