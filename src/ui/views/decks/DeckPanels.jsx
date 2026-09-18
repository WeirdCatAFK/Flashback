/**
 * The Decks view's smaller panels: the new-deck form, the add-cards search
 * panel, and a deck's tag row.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createDeck, addEntry, searchCards, setDeckTags } from '../../api/decks';
import { getTags } from '../../api/documents';
import TagChipInput from '../../components/base/TagChipInput';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';

const SEARCH_DEBOUNCE = 250;
const SEARCH_LIMIT = 50;

export function NewDeckForm({ onCreated, onCancel }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const { globalHash } = await createDeck(name.trim(), description.trim());
      onCreated(globalHash);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="new-deck-form" onSubmit={submit}>
      <label>
        {t('Name')}
        <input ref={inputRef} className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Deck name')} required />
      </label>
      <label>
        {t('Description')}
        <textarea className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('Optional description')} rows={2} />
      </label>
      <div className="new-deck-actions">
        <button type="button" className="btn" onClick={onCancel}>{t('Cancel')}</button>
        <button type="submit" className="btn btn--primary" disabled={saving || !name.trim()}>
          {saving ? t('Creating…') : t('Create')}
        </button>
      </div>
    </form>
  );
}

export function AddCardsPanel({ deckHash, existingHashes, onAdded, onClose }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [adding, setAdding] = useState(new Set());
  const [added, setAdded] = useState(new Set(existingHashes));
  const debounceRef = useRef(null);

  const fetchCards = useCallback((q) => {
    searchCards({ search: q || null, limit: SEARCH_LIMIT }).then((res) => {
      setResults(res.cards);
      setTotal(res.total);
    }).catch(console.error);
  }, []);

  useEffect(() => { fetchCards(''); }, [fetchCards]);

  const onQueryChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchCards(val), SEARCH_DEBOUNCE);
  };

  const handleAdd = async (card) => {
    setAdding((prev) => new Set(prev).add(card.global_hash));
    try {
      await addEntry(deckHash, card.global_hash, card.document_path ?? null);
      setAdded((prev) => new Set(prev).add(card.global_hash));
      onAdded();
    } catch (err) {
      if (err.status === 409) setAdded((prev) => new Set(prev).add(card.global_hash));
    } finally {
      setAdding((prev) => { const n = new Set(prev); n.delete(card.global_hash); return n; });
    }
  };

  return (
    <div className="add-cards-panel">
      <div className="header-row add-cards-header">
        <span className="add-cards-title">{t('Add cards to deck')}</span>
        <button type="button" className="btn-close" onClick={onClose} title={t('Close')}>×</button>
      </div>
      <div className="add-cards-search">
        <input className="field" autoFocus placeholder={t('Search cards…')} aria-label={t('Search cards')} value={query} onChange={onQueryChange} />
      </div>
      <div className="add-cards-results">
        {results.length === 0 && <div className="muted add-cards-empty">{t('No cards found.')}</div>}
        {results.map((card) => {
          const isAdded = added.has(card.global_hash);
          const isAdding = adding.has(card.global_hash);
          return (
            <div key={card.global_hash} className="add-card-row">
              <div className="add-card-row-body">
                <div className="add-card-front">{card.frontText || card.name || t('(untitled)')}</div>
                {card.document_name && <div className="add-card-doc">{card.document_name}</div>}
              </div>
              <button type="button" className="btn btn--sm" disabled={isAdded || isAdding} onClick={() => handleAdd(card)}>
                {isAdded ? t('Added') : isAdding ? '…' : t('+ Add')}
              </button>
            </div>
          );
        })}
      </div>
      <div className="add-cards-info">{t('Showing {shown} of {total} cards', { shown: results.length, total })}</div>
    </div>
  );
}

export function DeckTags({ deckHash, tags, onChanged }) {
  const { t } = useT();
  const { can } = useSession();
  const mayEdit = can('manageDecks');
  const [allTags, setAllTags] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTags().then(({ tags: all }) => setAllTags(all ?? [])).catch(() => {});
  }, []);

  const save = async (next) => {
    setSaving(true);
    try { await setDeckTags(deckHash, next); onChanged(); } catch (err) { console.error(err); } finally { setSaving(false); }
  };

  return (
    <div className="deck-tags" aria-busy={saving}>
      <span className="eyebrow deck-tags-label">{t('Tags')}</span>
      {mayEdit ? (
        <TagChipInput
          tags={tags}
          onAdd={(name) => { if (!tags.includes(name)) save([...tags, name]); }}
          onRemove={(name) => save(tags.filter((tag) => tag !== name))}
          allKnownTags={allTags}
          placeholder={t('Add a tag…')}
          chipClass="tag-chip--direct"
        />
      ) : (
        <div className="tags-chip-row">
          {tags.length === 0
            ? <span className="deck-tags-hint">{t('No tags.')}</span>
            : tags.map((tag) => <span key={tag} className="tag-chip tag-chip--direct">{tag}</span>)}
        </div>
      )}
      <span className="deck-tags-hint">{t('Tags flow down to every card in this deck.')}</span>
    </div>
  );
}
