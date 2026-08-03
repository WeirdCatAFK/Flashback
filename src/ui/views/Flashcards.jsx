import { useState, useEffect, useRef, useCallback } from 'react';
import { getStats } from '../api/srs';
import { searchCards, deleteCard } from '../api/decks';
import StandaloneCardModal from '../components/shared/StandaloneCardModal';
import CardDetailModal from '../components/shared/CardDetailModal';
import { ErrorState } from '../components/shared/StateView';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { relativeFromIso } from '../utils/relativeTime';
import { useDataInvalidation } from '../utils/dataBus';
import './Flashcards.css';

const CARD_TYPES = ['basic', 'reversible', 'cloze', 'type_answer', 'custom'];
const SORT_OPTIONS = [
    { value: 'level:desc', label: 'Level ↓' },
    { value: 'level:asc',  label: 'Level ↑' },
    { value: 'name:asc',   label: 'Name A–Z' },
    { value: 'name:desc',  label: 'Name Z–A' },
    { value: 'last_recall:desc', label: 'Recently reviewed' },
    { value: 'last_recall:asc',  label: 'Least recently reviewed' },
    // FSRS-derived, so cards never rated under FSRS have no difficulty at all —
    // the query sinks them below the rated ones either way round.
    { value: 'difficulty:desc', label: 'Hardest first' },
    { value: 'difficulty:asc',  label: 'Easiest first' },
];
const PAGE_SIZE = 50;

// Card-health filters. The two guards are grouped under one pill because from the
// browser's point of view they say the same thing — "the failures here are about your
// routine, not this card" — and splitting them would imply a distinction the user
// cannot act on differently.
const FLAG_FILTERS = [
    { value: 'any', label: 'flagged', title: 'Cards the review classifier has flagged' },
    { value: 'mouthful', label: 'overloaded', title: 'Cards that keep resetting to a short interval and look like too much at once' },
    { value: 'probe', label: 'productive', title: 'Hard cards that are converging — worth keeping as they are' },
];

// Short labels for the `flags` column (a comma-joined list of kinds).
const FLAG_LABELS = {
    mouthful: 'overloaded',
    probe: 'productive',
    overdue_drift: 'reviewed late',
    session_fatigue: 'late in session',
};

function useStats() {
    const [stats, setStats] = useState(null);
    const [token, setToken] = useState(0);
    useEffect(() => { getStats().then(setStats).catch(() => {}); }, [token]);
    const refreshStats = useCallback(() => setToken(t => t + 1), []);
    return { stats, refreshStats };
}

function LevelDot({ level }) {
    const hue = Math.min(level * 20, 120);
    return (
        <span className="fc-level-dot" style={{ background: `hsl(${hue},60%,45%)` }} title={`Level ${level}`}>
            {level}
        </span>
    );
}

function RelativeTime({ iso }) {
    if (!iso) return null;
    return <span className="fc-time" title={iso}>{relativeFromIso(iso)}</span>;
}

export default function FlashcardsView() {
    const { stats, refreshStats } = useStats();

    const [query, setQuery]         = useState('');
    const [levelFilter, setLevel]   = useState(null);
    const [cardType, setCardType]   = useState(null);
    // Card-health filter: null = off, 'any' = carries a flag of any kind, otherwise a
    // specific signature. This is the vault-wide view of what the classifier has raised
    // — a filter on the list where cards are already hunted down, not a separate inbox.
    const [flagFilter, setFlagFilter] = useState(null);
    const [sort, setSort]           = useState('level:desc');
    const [page, setPage]           = useState(0);

    const [cards, setCards]   = useState([]);
    const [total, setTotal]   = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError]   = useState(null);
    const [showNewCard, setShowNewCard] = useState(false);
    // Plain view state, not a route — a future Inbox alert (Backlog item 12) can
    // open a card here by setting it.
    const [detailHash, setDetailHash] = useState(null);

    const debounceRef = useRef(null);
    const confirm = useConfirm();

    const [sortBy, sortDir] = sort.split(':');

    // One object rather than a positional argument list: this grew to six parameters —
    // two of them same-typed strings from a split — before the flag filter arrived, and
    // every caller below repeated the order by hand.
    const searchArgs = {
        search: query || null,
        level: levelFilter,
        cardType,
        flagged: flagFilter !== null,
        flagKind: flagFilter === 'any' ? null : flagFilter,
        sortBy, sortDir,
    };

    const loadCards = useCallback((args, pg) => {
        setLoading(true);
        setError(null);
        searchCards({ ...args, limit: PAGE_SIZE, offset: pg * PAGE_SIZE })
            .then(res => { setCards(res.cards); setTotal(res.total); })
            .catch(setError)
            .finally(() => setLoading(false));
    }, []);

    // Re-fetch whenever any filter/sort/page changes (debounce only on text query).
    // searchArgs is rebuilt every render, so the effect keys off its contents.
    const searchKey = JSON.stringify(searchArgs);
    useEffect(() => {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(
            () => loadCards(JSON.parse(searchKey), page),
            query ? 250 : 0
        );
    }, [searchKey, page, query, loadCards]);

    // A Seal rollback / Vault Doctor sync rewrote the card index — reload the
    // current page and the level histogram so the list reflects the restore.
    useDataInvalidation(() => {
        loadCards(searchArgs, page);
        refreshStats();
    });

    const resetToPage0 = () => setPage(0); // page reset helper — called by filter changes

    const handleLevelClick = (lv) => {
        setLevel(prev => prev === lv ? null : lv);
        resetToPage0();
    };

    const handleCardType = (ct) => {
        setCardType(prev => prev === ct ? null : ct);
        resetToPage0();
    };

    const handleFlagFilter = (value) => {
        setFlagFilter(prev => prev === value ? null : value);
        resetToPage0();
    };

    const handleSort = (val) => {
        setSort(val);
        resetToPage0();
    };

    // Deletes standalone and document-anchored cards alike. This view is the only
    // place cards can be filtered by name, which makes it the practical place to hunt
    // one down and remove it — so the confirmation names the source document rather
    // than sending the user off to open it and delete from the Inspector.
    const handleDeleteCard = async (card) => {
        const ok = await confirm({
            title: 'Delete this card?',
            message: card.document_name
                ? `This permanently removes the card from ${card.document_name}, including its review history. The document itself is untouched. This cannot be undone.`
                : 'This permanently removes the standalone card, including its review history. This cannot be undone.',
            confirmLabel: 'Delete card',
            tone: 'danger',
        });
        if (!ok) return;
        try {
            await deleteCard(card.global_hash);
            loadCards(searchArgs, page);
        } catch (err) {
            setError(err);
        }
    };

    const handleQueryChange = (e) => {
        setQuery(e.target.value);
        setPage(0);
    };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const totalCards = stats?.total ?? 0;
    const boxes = stats?.boxes ?? [];

    const hasFilters = query || levelFilter !== null || cardType || flagFilter !== null;

    return (
        <>
        <div className="flashcards-view">
            {/* ── Sidebar ────────────────────────────────────────────────── */}
            <div className="fc-sidebar">
                <div className="fc-sidebar-header">
                    <span className="fc-sidebar-title">Levels</span>
                    {levelFilter !== null && (
                        <button className="fc-clear-level" onClick={() => { setLevel(null); setPage(0); }}>
                            clear
                        </button>
                    )}
                </div>
                <div className="fc-stats">
                    <div className="fc-stats-total">{totalCards} cards total</div>
                    {boxes.map(b => {
                        const pct = totalCards > 0 ? (b.count / totalCards) * 100 : 0;
                        const active = levelFilter === b.level;
                        return (
                            <button
                                key={b.level}
                                className={`fc-box-row fc-box-btn${active ? ' fc-box-btn--active' : ''}`}
                                onClick={() => handleLevelClick(b.level)}
                                title={`Filter to level ${b.level}`}
                            >
                                <span className="fc-box-label">L{b.level}</span>
                                <div className="fc-box-track">
                                    <div className="fc-box-fill" style={{ width: `${pct}%` }} />
                                </div>
                                <span className="fc-box-count">{b.count}</span>
                            </button>
                        );
                    })}
                    {stats && (
                        <div className="fc-mastery">
                            Mastery {stats.masteryPercentage?.toFixed(0) ?? 0}%
                        </div>
                    )}
                </div>
            </div>

            {/* ── Main ───────────────────────────────────────────────────── */}
            <div className="fc-main">
                {/* Search + sort bar */}
                <div className="fc-toolbar">
                    <input
                        className="fc-search-input"
                        placeholder="Search cards…"
                        aria-label="Search cards"
                        value={query}
                        onChange={handleQueryChange}
                    />
                    <select
                        className="fc-sort-select"
                        value={sort}
                        onChange={e => handleSort(e.target.value)}
                        aria-label="Sort cards"
                    >
                        {SORT_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                    <button
                        className="fc-new-card-btn"
                        onClick={() => setShowNewCard(true)}
                        title="Create a standalone card"
                    >
                        + New card
                    </button>
                </div>

                {/* Card-type filter pills */}
                <div className="fc-filter-bar">
                    {CARD_TYPES.map(ct => (
                        <button
                            key={ct}
                            className={`fc-type-pill${cardType === ct ? ' fc-type-pill--active' : ''}`}
                            onClick={() => handleCardType(ct)}
                        >
                            {ct.replace('_', ' ')}
                        </button>
                    ))}
                    {/* Card health. Separated from the type pills because it filters on
                        behaviour rather than on what a card is. */}
                    <span className="fc-filter-divider" aria-hidden="true" />
                    {FLAG_FILTERS.map(f => (
                        <button
                            key={f.value}
                            className={`fc-type-pill fc-flag-pill${flagFilter === f.value ? ' fc-type-pill--active' : ''}`}
                            onClick={() => handleFlagFilter(f.value)}
                            title={f.title}
                        >
                            {f.label}
                        </button>
                    ))}
                    <span className="fc-filter-count">
                        {loading ? '…' : `${total} card${total !== 1 ? 's' : ''}`}
                        {hasFilters && !loading && ' (filtered)'}
                    </span>
                    {hasFilters && (
                        <button
                            className="fc-clear-all"
                            onClick={() => {
                                setQuery(''); setLevel(null); setCardType(null);
                                setFlagFilter(null); setPage(0);
                            }}
                        >
                            Clear filters
                        </button>
                    )}
                </div>

                {/* Card list */}
                <div className="fc-card-list">
                    {cards.map(card => (
                        // The row holds its own delete button, so it can't be a <button>;
                        // it carries the button role and key handling instead.
                        <div
                            key={card.global_hash}
                            className={`fc-card-row${!card.document_name ? ' fc-card-row--standalone' : ''}`}
                            role="button"
                            tabIndex={0}
                            title="Open card details"
                            onClick={() => setDetailHash(card.global_hash)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setDetailHash(card.global_hash);
                                }
                            }}
                        >
                            <LevelDot level={card.level ?? 0} />
                            <div className="fc-card-body">
                                <div className="fc-card-front">{card.frontText || card.name || '(untitled)'}</div>
                                {card.backText && <div className="fc-card-back">{card.backText}</div>}
                            </div>
                            <div className="fc-card-meta">
                                {card.flags && card.flags.split(',').map(kind => (
                                    <span key={kind} className={`fc-card-flag fc-card-flag--${kind}`}
                                        title="Open the card to see what this rests on">
                                        {FLAG_LABELS[kind] ?? kind}
                                    </span>
                                ))}
                                {card.difficulty != null && (
                                    <span
                                        className="fc-card-difficulty"
                                        title={`FSRS difficulty ${card.difficulty.toFixed(1)} of 10 — how much effort this card costs to keep remembered`}
                                    >
                                        D {card.difficulty.toFixed(1)}
                                    </span>
                                )}
                                {card.category && (
                                    <span className="fc-card-category">{card.category}</span>
                                )}
                                {card.card_type && card.card_type !== 'basic' && (
                                    <span className="fc-card-type">{card.card_type.replace('_', ' ')}</span>
                                )}
                                {card.document_name ? (
                                    <span className="fc-card-doc" title={card.document_path}>
                                        {card.document_name}
                                    </span>
                                ) : (
                                    <span className="fc-card-standalone" title="Standalone card">standalone</span>
                                )}
                                <RelativeTime iso={card.last_recall} />
                                <button
                                    className="fc-card-delete"
                                    title={card.document_name ? `Delete card from ${card.document_name}` : 'Delete card'}
                                    onClick={(e) => { e.stopPropagation(); handleDeleteCard(card); }}
                                >
                                    ✕
                                </button>
                            </div>
                        </div>
                    ))}
                    {!loading && error && (
                        <ErrorState
                            error={error}
                            title="Couldn't load your cards"
                            onRetry={() => loadCards(searchArgs, page)}
                        />
                    )}
                    {!loading && !error && cards.length === 0 && (
                        <div className="fc-empty">No cards found.</div>
                    )}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="fc-pagination">
                        <button
                            className="fc-page-btn"
                            disabled={page === 0}
                            onClick={() => setPage(p => p - 1)}
                        >
                            ‹ Prev
                        </button>
                        <span className="fc-page-info">
                            {page + 1} / {totalPages}
                        </span>
                        <button
                            className="fc-page-btn"
                            disabled={page >= totalPages - 1}
                            onClick={() => setPage(p => p + 1)}
                        >
                            Next ›
                        </button>
                    </div>
                )}
            </div>
        </div>
        {detailHash && (
            <CardDetailModal
                hash={detailHash}
                onClose={() => setDetailHash(null)}
                onSaved={() => { loadCards(searchArgs, page); refreshStats(); }}
            />
        )}
        {showNewCard && (
            <StandaloneCardModal
                onClose={() => setShowNewCard(false)}
                onCreated={() => {
                    setShowNewCard(false);
                    loadCards(searchArgs, page);
                }}
            />
        )}
        </>
    );
}
