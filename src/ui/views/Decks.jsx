import { useState, useEffect, useCallback, useRef } from 'react';
import { listDecks, createDeck, getDeck, updateDeck, deleteDeck, addEntry, removeEntry, searchCards } from '../api/decks';
import StandaloneCardModal from '../components/shared/StandaloneCardModal';
import './Decks.css';

// ── Hooks ────────────────────────────────────────────────────────────────────

function useDecks() {
    const [decks, setDecks] = useState([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(() => {
        listDecks().then(setDecks).catch(console.error).finally(() => setLoading(false));
    }, []);

    useEffect(() => { refresh(); }, [refresh]);
    return { decks, loading, refresh };
}

// ── NewDeckForm ──────────────────────────────────────────────────────────────

function NewDeckForm({ onCreated, onCancel }) {
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
                Name
                <input ref={inputRef} value={name} onChange={e => setName(e.target.value)} placeholder="Deck name" required />
            </label>
            <label>
                Description
                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" rows={2} />
            </label>
            <div className="new-deck-actions">
                <button type="button" className="deck-btn" onClick={onCancel}>Cancel</button>
                <button type="submit" className="deck-btn primary" disabled={saving || !name.trim()}>
                    {saving ? 'Creating…' : 'Create'}
                </button>
            </div>
        </form>
    );
}

// ── AddCardsPanel ────────────────────────────────────────────────────────────

function AddCardsPanel({ deckHash, existingHashes, onAdded, onClose }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [total, setTotal] = useState(0);
    const [adding, setAdding] = useState(new Set());
    const [added, setAdded] = useState(new Set(existingHashes));
    const debounceRef = useRef(null);

    const fetchCards = useCallback((q) => {
        searchCards({ search: q || null, limit: 50 }).then(res => {
            setResults(res.cards);
            setTotal(res.total);
        }).catch(console.error);
    }, []);

    useEffect(() => { fetchCards(''); }, [fetchCards]);

    const onQueryChange = (e) => {
        const val = e.target.value;
        setQuery(val);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchCards(val), 250);
    };

    const handleAdd = async (card) => {
        setAdding(prev => new Set(prev).add(card.global_hash));
        try {
            await addEntry(deckHash, card.global_hash, card.document_path ?? null);
            setAdded(prev => new Set(prev).add(card.global_hash));
            onAdded();
        } catch (err) {
            if (err.status === 409) setAdded(prev => new Set(prev).add(card.global_hash));
        } finally {
            setAdding(prev => { const n = new Set(prev); n.delete(card.global_hash); return n; });
        }
    };

    return (
        <div className="add-cards-panel">
            <div className="add-cards-header">
                <span className="add-cards-title">Add cards to deck</span>
                <button type="button" className="add-cards-close" onClick={onClose} title="Close">×</button>
            </div>
            <div className="add-cards-search">
                <input autoFocus placeholder="Search cards…" aria-label="Search cards" value={query} onChange={onQueryChange} />
            </div>
            <div className="add-cards-results">
                {results.length === 0 && (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-fg-secondary)', fontSize: 12 }}>
                        No cards found.
                    </div>
                )}
                {results.map(card => {
                    const isAdded = added.has(card.global_hash);
                    const isAdding = adding.has(card.global_hash);
                    return (
                        <div key={card.global_hash} className="add-card-row">
                            <div className="add-card-row-body">
                                <div className="add-card-front">{card.frontText || card.name || '(untitled)'}</div>
                                {card.document_name && <div className="add-card-doc">{card.document_name}</div>}
                            </div>
                            <button type="button" className="add-card-btn" disabled={isAdded || isAdding} onClick={() => handleAdd(card)}>
                                {isAdded ? 'Added' : isAdding ? '…' : '+ Add'}
                            </button>
                        </div>
                    );
                })}
            </div>
            <div className="add-cards-info">Showing {results.length} of {total} cards</div>
        </div>
    );
}

// ── CardRow ──────────────────────────────────────────────────────────────────

function CardRow({ entry, onRemove }) {
    const front = entry.frontText || entry.card_name || '(untitled)';
    const back = entry.backText || '';
    const level = entry.level ?? 0;
    const docName = entry.document_path ? entry.document_path.split('/').pop().split('\\').pop() : null;

    return (
        <div className="card-row">
            <div className="card-row-level">{level}</div>
            <div className="card-row-body">
                <div className="card-row-front">{front}</div>
                {back && <div className="card-row-back">{back}</div>}
            </div>
            <div className="card-row-meta">
                {entry.card_type && entry.card_type !== 'basic' && (
                    <span className="card-type-badge">{entry.card_type.replace('_', ' ')}</span>
                )}
                {docName && <span className="card-doc-badge" title={entry.document_path}>{docName}</span>}
            </div>
            <button type="button" className="card-row-remove" title="Remove from deck" onClick={onRemove}>×</button>
        </div>
    );
}

// ── DeckDetail ───────────────────────────────────────────────────────────────

function DeckDetail({ deckHash, onDeleted, onRefreshList, onStudy }) {
    const [deck, setDeck] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showAddPanel, setShowAddPanel] = useState(false);
    const [showNewCard, setShowNewCard] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameVal, setRenameVal] = useState('');

    const load = useCallback(() => {
        setLoading(true);
        getDeck(deckHash).then(d => { setDeck(d); setLoading(false); }).catch(console.error);
    }, [deckHash]);

    // Reset the add panel inline when the deck changes; the async fetch stays in an effect.
    const [prevLoad, setPrevLoad] = useState(() => load);
    if (prevLoad !== load) { setPrevLoad(load); setShowAddPanel(false); }
    useEffect(() => { load(); }, [load]);

    const handleRemoveEntry = async (cardHash) => {
        try { await removeEntry(deckHash, cardHash); load(); onRefreshList(); }
        catch (err) { console.error(err); }
    };

    const handleDelete = async () => {
        if (!confirm(`Delete deck "${deck.name}"? This cannot be undone.`)) return;
        try { await deleteDeck(deckHash); onDeleted(); }
        catch (err) { console.error(err); }
    };

    const startRename = () => { setRenameVal(deck.name); setRenaming(true); };

    const submitRename = async (e) => {
        e.preventDefault();
        if (!renameVal.trim()) return;
        try {
            await updateDeck(deckHash, { name: renameVal.trim(), description: deck.description });
            setRenaming(false);
            load();
            onRefreshList();
        } catch (err) { console.error(err); }
    };

    if (loading) return (
        <div className="deck-content">
            <div className="deck-empty-state"><span className="deck-empty-text">Loading…</span></div>
        </div>
    );
    if (!deck) return null;

    const existingHashes = new Set((deck.entries || []).map(e => e.card_hash));

    return (
        <>
        <div className="deck-content" style={{ position: 'relative' }}>
            <div className="deck-detail-header">
                <div className="deck-detail-title-group">
                    {renaming ? (
                        <form onSubmit={submitRename} style={{ display: 'flex', gap: 6 }}>
                            <input className="deck-detail-name-input" autoFocus aria-label="Deck name" value={renameVal}
                                onChange={e => setRenameVal(e.target.value)} onBlur={() => setRenaming(false)} />
                        </form>
                    ) : (
                        <h2 className="deck-detail-name" onDoubleClick={startRename} title="Double-click to rename">
                            {deck.name}
                        </h2>
                    )}
                    <div className="deck-detail-meta">
                        {deck.entries?.length ?? 0} card{deck.entries?.length !== 1 ? 's' : ''}
                        {deck.description ? ` · ${deck.description}` : ''}
                        {deck.is_system && <span className="deck-system-badge deck-system-badge--detail">default deck · standalone cards live here</span>}
                    </div>
                </div>
                <div className="deck-detail-actions">
                    {deck.entries?.length > 0 && (
                        <button type="button" className="deck-btn primary" onClick={() => onStudy(deck)}>▶ Study</button>
                    )}
                    {deck.is_system && (
                        <button type="button" className="deck-btn" onClick={() => setShowNewCard(true)}>+ New card</button>
                    )}
                    <button type="button" className="deck-btn" onClick={() => setShowAddPanel(v => !v)}>+ Add cards</button>
                    {!deck.is_system && (
                        <button type="button" className="deck-btn danger" onClick={handleDelete}>Delete</button>
                    )}
                </div>
            </div>

            <div className="deck-cards-area">
                {deck.entries?.length === 0 ? (
                    <div className="deck-cards-empty">
                        This deck is empty.<br />Click <strong>+ Add cards</strong> to pick cards from your library.
                    </div>
                ) : (
                    deck.entries.map(entry => (
                        <CardRow key={entry.card_hash} entry={entry} onRemove={() => handleRemoveEntry(entry.card_hash)} />
                    ))
                )}
            </div>

            {showAddPanel && (
                <AddCardsPanel deckHash={deckHash} existingHashes={existingHashes}
                    onAdded={() => { load(); onRefreshList(); }} onClose={() => setShowAddPanel(false)} />
            )}
        </div>
        {showNewCard && (
            <StandaloneCardModal
                onClose={() => setShowNewCard(false)}
                onCreated={() => { setShowNewCard(false); load(); onRefreshList(); }}
            />
        )}
        </>
    );
}

// ── Main view ────────────────────────────────────────────────────────────────

export default function DecksView({ onStudyDeck }) {
    const { decks, loading, refresh } = useDecks();
    const [activeDeck, setActiveDeck] = useState(null);
    const [creating, setCreating] = useState(false);

    const handleCreated = (hash) => { setCreating(false); refresh(); setActiveDeck(hash); };
    const handleDeleted = () => { setActiveDeck(null); refresh(); };
    const handleStudy = (deck) => onStudyDeck?.({ deck: deck.global_hash, deckName: deck.name });

    return (
        <div className="decks-view">
            <div className="decks-panel">
                <div className="decks-panel-header">
                    <span className="decks-panel-title">Decks</span>
                    <button type="button" className="decks-panel-new" title="New deck" onClick={() => { setCreating(true); setActiveDeck(null); }}>+</button>
                </div>

                <div className="decks-list">
                    {loading && <div className="decks-empty">Loading…</div>}
                    {!loading && decks.length === 0 && !creating && (
                        <div className="decks-empty">No decks yet.<br />Click + to create one.</div>
                    )}
                    {decks.map(deck => (
                        <div key={deck.global_hash}
                            className={`deck-item${activeDeck === deck.global_hash ? ' active' : ''}`}
                            onClick={() => { setActiveDeck(deck.global_hash); setCreating(false); }}>
                            <span className="deck-item-icon">▤</span>
                            <div className="deck-item-info">
                                <div className="deck-item-name">
                                    {deck.name}
                                    {deck.is_system ? <span className="deck-system-badge">default</span> : null}
                                </div>
                                <div className="deck-item-count">{deck.entry_count} card{deck.entry_count !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="deck-content">
                {creating ? (
                    <>
                        <div className="deck-detail-header">
                            <div className="deck-detail-title-group">
                                <h2 className="deck-detail-name">New Deck</h2>
                            </div>
                        </div>
                        <NewDeckForm onCreated={handleCreated} onCancel={() => setCreating(false)} />
                    </>
                ) : activeDeck ? (
                    <DeckDetail key={activeDeck} deckHash={activeDeck}
                        onDeleted={handleDeleted} onRefreshList={refresh} onStudy={handleStudy} />
                ) : (
                    <div className="deck-empty-state">
                        <div className="deck-empty-icon">▤</div>
                        <div className="deck-empty-text">Select a deck or create a new one to get started.</div>
                    </div>
                )}
            </div>
        </div>
    );
}
