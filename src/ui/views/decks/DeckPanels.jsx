/**
 * The deck page's smaller panels: the add-cards layer and a deck's tag row.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { addEntry, searchCards, setDeckTags } from '../../api/decks';
import { frontLine, docTitle } from '../../components/flashcard/cardLineText.js';
import { getTags } from '../../api/documents';
import TagChipInput from '../../components/base/TagChipInput';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';

const SEARCH_DEBOUNCE = 250;
const SEARCH_LIMIT = 50;

/**
 * Adding cards: a layer over the deck page that searches every card in your
 * library. A row says whether the card is already in this deck; choosing one that
 * is not adds it. Escape or the Esc key closes it.
 */
export function AddCardsPanel({ deckHash, deckName, existingHashes, onAdded, onClose }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [adding, setAdding] = useState(new Set());
  const [added, setAdded] = useState(new Set(existingHashes));
  const debounceRef = useRef(null);

  const fetchCards = useCallback((q) => {
    searchCards({ search: q || null, sortBy: 'front', sortDir: 'asc', limit: SEARCH_LIMIT }).then((res) => {
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
    if (added.has(card.global_hash) || adding.has(card.global_hash)) return;
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
    <div
      className="dk-finder"
      role="dialog"
      aria-label={t('Add cards to {deck}', { deck: deckName })}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="dk-finder-head">
        <input
          type="search"
          autoFocus
          placeholder={t('Find cards to add')}
          aria-label={t('Find cards to add')}
          value={query}
          onChange={onQueryChange}
        />
        <button type="button" className="dk-finder-close" onClick={onClose} aria-label={t('Close')}>{t('Esc')}</button>
      </div>
      <div className="dk-finder-body">
        {results.length === 0 && <p className="dk-finder-empty">{t('No card matches.')}</p>}
        {results.map((card) => {
          const isAdded = added.has(card.global_hash);
          const isAdding = adding.has(card.global_hash);
          return (
            <button
              key={card.global_hash}
              type="button"
              className={`dk-pick${isAdded ? ' is-in' : ''}`}
              onClick={() => handleAdd(card)}
              aria-disabled={isAdded}
            >
              <i aria-hidden="true" />
              <span className="dk-pick-text">{frontLine(card) || t('(empty card)')}</span>
              <span className="dk-pick-meta">
                <span>{card.document_path ? docTitle(card.document_path) : t('Cards')}</span>
                <span>{isAdded ? t('in this deck') : isAdding ? '…' : <b>{t('Add')}</b>}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="dk-finder-foot">{t('Showing {shown} of {total} cards', { shown: results.length, total })}</div>
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
