import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { superSearch } from '../../api/search';
import IconFolder from '../icons/IconFolder';
import IconFile from '../icons/IconFile';
import IconFlashcards from '../icons/IconFlashcards';
import IconDecks from '../icons/IconDecks';
import './SearchModal.css';

// Matches "tag:foo", "deck:foo", "doc:foo", "in:foo" at start of input
const PREFIX_RE = /^(tag|deck|doc|in):(.*)$/i;

function parseQuery(raw) {
    const m = raw.match(PREFIX_RE);
    if (m) {
        const prefix = m[1].toLowerCase();
        const value  = m[2];
        return {
            tag:      prefix === 'tag'  ? value : null,
            deck:     prefix === 'deck' ? value : null,
            document: prefix === 'doc'  ? value : null,
            folder:   prefix === 'in'   ? value : null,
            q:        null,
            prefix,
            value,
        };
    }
    return { q: raw, tag: null, deck: null, document: null, folder: null, prefix: null, value: null };
}

function snippet(text, maxLen = 80) {
    if (!text) return '';
    const s = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function lastName(path) {
    if (!path) return '';
    return path.replace(/\\/g, '/').split('/').pop();
}

const TYPE_LABELS = { folder: 'Folders', document: 'Documents', flashcard: 'Cards', tag: 'Tags', deck: 'Decks' };

function TagIcon({ size = 16 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
            <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>
    );
}

function ResultIcon({ type }) {
    switch (type) {
        case 'folder':    return <IconFolder size={15} />;
        case 'document':  return <IconFile size={15} />;
        case 'flashcard': return <IconFlashcards size={15} />;
        case 'tag':       return <TagIcon size={15} />;
        case 'deck':      return <IconDecks size={15} />;
        default:          return null;
    }
}

function ResultRow({ item, active, onActivate, onNavigate }) {
    const ref = useRef(null);

    useEffect(() => {
        if (active) ref.current?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    let primary = '';
    let secondary = '';

    switch (item.type) {
        case 'folder':
            primary   = item.name;
            secondary = item.path;
            break;
        case 'document':
            primary   = item.name;
            secondary = item.path;
            break;
        case 'flashcard':
            primary   = item.name || snippet(item.frontText) || item.global_hash.slice(0, 8);
            secondary = item.document_name || '';
            break;
        case 'tag':
            primary = item.name;
            break;
        case 'deck':
            primary = item.name;
            break;
    }

    return (
        <div
            ref={ref}
            className={`sq-result${active ? ' sq-result--active' : ''}`}
            onMouseEnter={onActivate}
            onClick={() => onNavigate(item)}
        >
            <span className={`sq-result-icon sq-result-icon--${item.type}`}>
                <ResultIcon type={item.type} />
            </span>
            <span className="sq-result-primary">{primary}</span>
            {secondary && <span className="sq-result-secondary">{secondary}</span>}
        </div>
    );
}

export default function SearchModal({ onClose, onNavigate }) {
    const [query, setQuery]     = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [focusIdx, setFocusIdx] = useState(0);

    const inputRef   = useRef(null);
    const debounceRef = useRef(null);

    useEffect(() => { inputRef.current?.focus(); }, []);

    const flatItems = useMemo(() => {
        if (!results) return [];
        const out = [];
        if (results.folders)    results.folders.forEach(r    => out.push({ ...r, type: 'folder' }));
        if (results.documents)  results.documents.forEach(r  => out.push({ ...r, type: 'document' }));
        if (results.flashcards) results.flashcards.forEach(r => out.push({ ...r, type: 'flashcard' }));
        if (results.tags)       results.tags.forEach(r       => out.push({ ...r, type: 'tag' }));
        if (results.decks)      results.decks.forEach(r      => out.push({ ...r, type: 'deck' }));
        return out;
    }, [results]);

    const doSearch = useCallback(async (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) { setResults(null); setLoading(false); return; }

        const parsed = parseQuery(trimmed);
        const params = {
            q:        parsed.q,
            tag:      parsed.tag,
            deck:     parsed.deck,
            document: parsed.document,
            folder:   parsed.folder,
        };

        // Don't fire if the only filter value is empty (user typed "tag:" but nothing yet)
        const hasFilter = parsed.tag != null || parsed.deck != null || parsed.document != null || parsed.folder != null;
        if (hasFilter && !parsed.value?.trim()) {
            setResults(null);
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(false);
        try {
            const data = await superSearch(params);
            setResults(data);
            setFocusIdx(0);
        } catch (err) {
            console.error(err);
            setError(true);
            setResults(null);
        } finally {
            setLoading(false);
        }
    }, []);

    const handleChange = useCallback((e) => {
        const val = e.target.value;
        setQuery(val);
        setLoading(true);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => doSearch(val), 200);
    }, [doSearch]);

    const handleNavigate = useCallback((item) => {
        switch (item.type) {
            case 'folder':
                onNavigate({ type: 'folder', payload: { path: item.path } });
                break;
            case 'document':
                onNavigate({ type: 'document', payload: { path: item.path } });
                break;
            case 'flashcard':
                onNavigate({ type: 'flashcard', payload: { documentPath: item.document_path, globalHash: item.global_hash } });
                break;
            case 'tag':
                onNavigate({ type: 'tag', payload: { name: item.name } });
                break;
            case 'deck':
                onNavigate({ type: 'deck', payload: { hash: item.global_hash, name: item.name } });
                break;
        }
        onClose();
    }, [onNavigate, onClose]);

    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Escape') { onClose(); return; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setFocusIdx(i => Math.min(i + 1, flatItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setFocusIdx(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (flatItems[focusIdx]) handleNavigate(flatItems[focusIdx]);
        }
    }, [flatItems, focusIdx, handleNavigate, onClose]);

    // Determine the current mode hint
    const parsed = parseQuery(query);
    const modeHint = parsed.prefix ? {
        tag: 'Cards with tag', deck: 'Cards in deck',
        doc: 'Cards in document', in: 'Cards in folder',
    }[parsed.prefix] : null;

    // Group for display — only used in global mode
    const groups = useMemo(() => {
        if (!results || results.flashcards && !results.folders) return null;
        const g = [];
        const pairs = [
            ['folder',    results.folders],
            ['document',  results.documents],
            ['flashcard', results.flashcards],
            ['tag',       results.tags],
            ['deck',      results.decks],
        ];
        let offset = 0;
        for (const [type, items] of pairs) {
            if (items?.length) {
                g.push({ type, items: items.map(r => ({ ...r, type })), offset });
                offset += items.length;
            }
        }
        return g;
    }, [results]);

    const isEmpty = results && flatItems.length === 0;

    const modal = (
        <div className="sq-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="sq-modal" role="dialog" aria-label="Search" onKeyDown={handleKeyDown}>
                <div className="sq-input-row">
                    <svg className="sq-search-icon" width="16" height="16" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        ref={inputRef}
                        className="sq-input"
                        value={query}
                        onChange={handleChange}
                        placeholder="Search… (tag: deck: doc: in:)"
                        spellCheck={false}
                        autoComplete="off"
                    />
                    {modeHint && <span className="sq-mode-hint">{modeHint}</span>}
                    {loading && <span className="sq-spinner" aria-hidden="true" />}
                    <kbd className="sq-esc-hint" onClick={onClose}>esc</kbd>
                </div>

                {error && (
                    <div className="sq-empty sq-empty--error"><span>Search failed. Check your connection and try again.</span></div>
                )}

                {!error && !results && !loading && (
                    <div className="sq-empty">
                        <p className="sq-hint-row"><span className="sq-prefix-chip">tag:</span> cards with tag &nbsp;·&nbsp; <span className="sq-prefix-chip">deck:</span> cards in deck</p>
                        <p className="sq-hint-row"><span className="sq-prefix-chip">doc:</span> cards by document &nbsp;·&nbsp; <span className="sq-prefix-chip">in:</span> cards in folder</p>
                    </div>
                )}

                {!error && isEmpty && <div className="sq-empty"><span>No results</span></div>}

                {flatItems.length > 0 && (
                    <div className="sq-results">
                        {/* Filter mode: flat list with no group headers */}
                        {!groups && flatItems.map((item, i) => (
                            <ResultRow
                                key={`${item.type}-${item.global_hash ?? item.name}-${i}`}
                                item={item}
                                active={focusIdx === i}
                                onActivate={() => setFocusIdx(i)}
                                onNavigate={handleNavigate}
                            />
                        ))}

                        {/* Global mode: grouped by type */}
                        {groups && groups.map((g) => (
                            <div key={g.type} className="sq-group">
                                <div className="sq-group-label">{TYPE_LABELS[g.type]}</div>
                                {g.items.map((item, j) => {
                                    const globalIdx = g.offset + j;
                                    return (
                                        <ResultRow
                                            key={`${item.type}-${item.global_hash ?? item.name}-${j}`}
                                            item={item}
                                            active={focusIdx === globalIdx}
                                            onActivate={() => setFocusIdx(globalIdx)}
                                            onNavigate={handleNavigate}
                                        />
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );

    return createPortal(modal, document.body);
}
