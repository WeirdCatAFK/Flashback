import { useState, useEffect, useRef, useCallback } from 'react';
import { getStats } from '../api/srs';
import { searchCards } from '../api/decks';
import './Flashcards.css';

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

export default function FlashcardsView() {
    const stats = useStats();
    const [query, setQuery] = useState('');
    const [cards, setCards] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const debounceRef = useRef(null);

    const loadCards = useCallback((q) => {
        setLoading(true);
        searchCards({ search: q || null, limit: 100 })
            .then(res => { setCards(res.cards); setTotal(res.total); })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { loadCards(''); }, [loadCards]);

    const onQueryChange = (e) => {
        const val = e.target.value;
        setQuery(val);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => loadCards(val), 250);
    };

    const totalCards = stats?.total ?? 0;
    const boxes = stats?.boxes ?? [];

    return (
        <div className="flashcards-view">
            <div className="fc-sidebar">
                <div className="fc-sidebar-header">
                    <span className="fc-sidebar-title">Leitner boxes</span>
                </div>
                <div className="fc-stats">
                    <div className="fc-stats-total">{totalCards} cards total</div>
                    {boxes.map(b => {
                        const pct = totalCards > 0 ? (b.count / totalCards) * 100 : 0;
                        return (
                            <div key={b.level} className="fc-box-row">
                                <span className="fc-box-label">L{b.level}</span>
                                <div className="fc-box-track">
                                    <div className="fc-box-fill" style={{ width: `${pct}%` }} />
                                </div>
                                <span className="fc-box-count">{b.count}</span>
                            </div>
                        );
                    })}
                    {stats && (
                        <div className="fc-mastery">
                            Mastery {stats.masteryPercentage?.toFixed(0) ?? 0}%
                        </div>
                    )}
                </div>
            </div>

            <div className="fc-main">
                <div className="fc-search-bar">
                    <input
                        className="fc-search-input"
                        placeholder="Search cards…"
                        aria-label="Search cards"
                        value={query}
                        onChange={onQueryChange}
                    />
                    <span className="fc-search-count">
                        {loading ? '…' : `${total} card${total !== 1 ? 's' : ''}`}
                    </span>
                </div>

                <div className="fc-card-list">
                    {cards.map(card => (
                        <div key={card.global_hash} className="fc-card-row">
                            <LevelDot level={card.level ?? 0} />
                            <div className="fc-card-body">
                                <div className="fc-card-front">{card.frontText || card.name || '(untitled)'}</div>
                                {card.backText && <div className="fc-card-back">{card.backText}</div>}
                            </div>
                            <div className="fc-card-meta">
                                {card.card_type && card.card_type !== 'basic' && (
                                    <span className="fc-card-type">{card.card_type.replace('_', ' ')}</span>
                                )}
                                {card.document_name && (
                                    <span className="fc-card-doc" title={card.document_path}>{card.document_name}</span>
                                )}
                            </div>
                        </div>
                    ))}
                    {!loading && cards.length === 0 && (
                        <div className="fc-empty">No cards found.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
