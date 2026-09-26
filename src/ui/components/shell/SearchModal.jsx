/**
 * SearchModal — the Ctrl+K palette: one input over everything in the vault,
 * with `tag:` / `deck:` / `doc:` / `in:` prefixes, results grouped by kind, and
 * arrow-key navigation. A top-placed Modal; state lives in useSearch.js.
 */

import { useEffect, useRef } from 'react';
import Modal from '../base/Modal';
import IconFolder from '../icons/IconFolder';
import IconFile from '../icons/IconFile';
import IconFlashcards from '../icons/IconFlashcards';
import IconDecks from '../icons/IconDecks';
import { useT } from '../../translations/index';
import { resultLines } from './search.js';
import useSearch from './useSearch';
import './SearchModal.css';

/** Group heading for a result type — a switch of literals so the extractor sees each. */
const typeLabel = (type, t) => {
  switch (type) {
    case 'folder': return t('Folders');
    case 'document': return t('Documents');
    case 'flashcard': return t('Cards');
    case 'tag': return t('Tags');
    case 'deck': return t('Decks');
    default: return type;
  }
};

function TagIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function ResultIcon({ type }) {
  switch (type) {
    case 'folder': return <IconFolder size={15} />;
    case 'document': return <IconFile size={15} />;
    case 'flashcard': return <IconFlashcards size={15} />;
    case 'tag': return <TagIcon size={15} />;
    case 'deck': return <IconDecks size={15} />;
    default: return null;
  }
}

function ResultRow({ item, active, onActivate, onNavigate }) {
  const ref = useRef(null);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const { primary, secondary } = resultLines(item);
  return (
    <div ref={ref} className={`sq-result${active ? ' sq-result--active' : ''}`} onMouseEnter={onActivate} onClick={() => onNavigate(item)}>
      <span className={`sq-result-icon sq-result-icon--${item.type}`}><ResultIcon type={item.type} /></span>
      <span className="sq-result-primary">{primary}</span>
      {secondary && <span className="sq-result-secondary">{secondary}</span>}
    </div>
  );
}

export default function SearchModal({ onClose, onNavigate }) {
  const { t } = useT();
  const s = useSearch({ onNavigate, onClose });
  const modeHint = { tag: t('Cards with tag'), deck: t('Cards in deck'), doc: t('Cards in document'), in: t('Cards in folder') }[s.parsed.prefix] ?? null;

  return (
    <Modal ariaLabel={t('Search')} onClose={onClose} placement="top" className="sq-modal">
      <div onKeyDown={s.onKeyDown}>
        <div className="sq-input-row">
          <svg className="sq-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="sq-input"
            value={s.query}
            onChange={(e) => s.change(e.target.value)}
            placeholder={t('Search… (tag: deck: doc: in:)')}
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          {modeHint && <span className="sq-mode-hint">{modeHint}</span>}
          {s.loading && <span className="spinner" aria-hidden="true" />}
          <kbd className="sq-esc-hint" onClick={onClose}>esc</kbd>
        </div>

        {s.error && <div className="sq-empty sq-empty--error"><span>{t('Search failed. Check your connection and try again.')}</span></div>}

        {!s.error && !s.results && !s.loading && (
          <div className="sq-empty">
            <p className="sq-hint-row">
              <span className="sq-prefix-chip">tag:</span> {t('cards with tag')} &nbsp;·&nbsp;
              <span className="sq-prefix-chip">deck:</span> {t('cards in deck')}
            </p>
            <p className="sq-hint-row">
              <span className="sq-prefix-chip">doc:</span> {t('cards by document')} &nbsp;·&nbsp;
              <span className="sq-prefix-chip">in:</span> {t('cards in folder')}
            </p>
          </div>
        )}

        {!s.error && s.isEmpty && <div className="sq-empty"><span>{t('No results')}</span></div>}

        {s.flatItems.length > 0 && (
          <div className="sq-results">
            {!s.groups && s.flatItems.map((item, i) => (
              <ResultRow key={`${item.type}-${item.global_hash ?? item.name}-${i}`} item={item} active={s.focusIdx === i} onActivate={() => s.setFocusIdx(i)} onNavigate={s.navigate} />
            ))}
            {s.groups && s.groups.map((g) => (
              <div key={g.type} className="sq-group">
                <div className="eyebrow sq-group-label">{typeLabel(g.type, t)}</div>
                {g.items.map((item, j) => {
                  const idx = g.offset + j;
                  return <ResultRow key={`${item.type}-${item.global_hash ?? item.name}-${j}`} item={item} active={s.focusIdx === idx} onActivate={() => s.setFocusIdx(idx)} onNavigate={s.navigate} />;
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
