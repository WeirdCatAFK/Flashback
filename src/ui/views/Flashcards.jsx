import { useState, useEffect, useRef, useCallback } from 'react';
import { getStats } from '../api/srs';
import { searchCards, deleteStandaloneCard } from '../api/decks';
import StandaloneCardModal from '../components/shared/StandaloneCardModal';
import { ErrorState } from '../components/shared/StateView';
import { useConfirm } from '../components/shared/ConfirmDialog';
import './Flashcards.css';

const CARD_TYPES = ['basic', 'reversible', 'cloze', 'type_answer', 'custom'];
const SORT_OPTIONS = [
    { value: 'level:desc', label: 'Level ↓' },
    { value: 'level:asc',  label: 'Level ↑' },
    { value: 'name:asc',   label: 'Name A–Z' },
    { value: 'name:desc',  label: 'Name Z–A' },
    { value: 'last_recall:desc', label: 'Recently reviewed' },
    { value: 'last_recall:asc',  label: 'Least recently reviewed' },
];
const PAGE_SIZE = 50;

function useStats() {
    const [stats, setStats] = useState(null);
    useEffect(() => { getStats().then(setStats).catch(() => {}); }, []);
    return stats;
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
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    const hrs  = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    let label;
    if (mins < 2)    label = 'just now';
    else if (hrs < 1) label = `${mins}m ago`;
    else if (days < 1) label = `${hrs}h ago`;
    else if (days < 30) label = `${days}d ago`;
    else label = new Date(iso).toLocaleDateString();
    return <span className="fc-time" title={iso}>{label}</span>;
}

export default function FlashcardsView() {
    const stats = useStats();

    const [query, setQuery]         = useState('');
    const [levelFilter, setLevel]   = useState(null);
    const [cardType, setCardType]   = useState(null);
    const [sort, setSort]           = useState('level:desc');
    const [page, setPage]           = useState(0);

    const [cards, setCards]   = useState([]);
    const [total, setTotal]   = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError]   = useState(null);
    const [showNewCard, setShowNewCard] = useState(false);

    const debounceRef = useRef(null);
    const confirm = useConfirm();

    const [sortBy, sortDir] = sort.split(':');

    const loadCards = useCallback((q, lv, ct, sb, sd, pg) => {
        setLoading(true);
        setError(null);
        const offset = pg * PAGE_SIZE;
        searchCards({ search: q || null, level: lv, cardType: ct, sortBy: sb, sortDir: sd, limit: PAGE_SIZE, offset })
            .then(res => { setCards(res.cards); setTotal(res.total); })
            .catch(setError)
            .finally(() => setLoading(false));
    }, []);

    // Re-fetch whenever any filter/sort/page changes (debounce only on text query)
    useEffect(() => {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(
            () => loadCards(query, levelFilter, cardType, sortBy, sortDir, page),
            query ? 250 : 0
        );
    }, [query, levelFilter, cardType, sortBy, sortDir, page, loadCards]);

    const resetToPage0 = () => setPage(0); // page reset helper — called by filter changes

    const handleLevelClick = (lv) => {
        setLevel(prev => prev === lv ? null : lv);
        resetToPage0();
    };

    const handleCardType = (ct) => {
        setCardType(prev => prev === ct ? null : ct);
        resetToPage0();
    };

    const handleSort = (val) => {
        setSort(val);
        resetToPage0();
    };

    const handleDeleteCard = async (hash) => {
        const ok = await confirm({
            title: 'Delete this card?',
            message: 'This permanently removes the standalone card. This cannot be undone.',
            confirmLabel: 'Delete card',
            tone: 'danger',
        });
        if (!ok) return;
        try {
            await deleteStandaloneCard(hash);
            loadCards(query, levelFilter, cardType, sortBy, sortDir, page);
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

    const hasFilters = query || levelFilter !== null || cardType;

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
                    <span className="fc-filter-count">
                        {loading ? '…' : `${total} card${total !== 1 ? 's' : ''}`}
                        {hasFilters && !loading && ' (filtered)'}
                    </span>
                    {hasFilters && (
                        <button
                            className="fc-clear-all"
                            onClick={() => { setQuery(''); setLevel(null); setCardType(null); setPage(0); }}
                        >
                            Clear filters
                        </button>
                    )}
                </div>

                {/* Card list */}
                <div className="fc-card-list">
                    {cards.map(card => (
                        <div key={card.global_hash} className={`fc-card-row${!card.document_name ? ' fc-card-row--standalone' : ''}`}>
                            <LevelDot level={card.level ?? 0} />
                            <div className="fc-card-body">
                                <div className="fc-card-front">{card.frontText || card.name || '(untitled)'}</div>
                                {card.backText && <div className="fc-card-back">{card.backText}</div>}
                            </div>
                            <div className="fc-card-meta">
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
                                {!card.document_name && (
                                    <button
                                        className="fc-card-delete"
                                        title="Delete card"
                                        onClick={() => handleDeleteCard(card.global_hash)}
                                    >
                                        ✕
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                    {!loading && error && (
                        <ErrorState
                            error={error}
                            title="Couldn't load your cards"
                            onRetry={() => loadCards(query, levelFilter, cardType, sortBy, sortDir, page)}
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
        {showNewCard && (
            <StandaloneCardModal
                onClose={() => setShowNewCard(false)}
                onCreated={() => {
                    setShowNewCard(false);
                    loadCards(query, levelFilter, cardType, sortBy, sortDir, page);
                }}
            />
        )}
        </>
    );
}
