import { useState, useEffect, useCallback, useRef } from 'react';
import { listDecks, createDeck, getDeck, updateDeck, deleteDeck, addEntry, removeEntry, searchCards, setDeckTags } from '../api/decks';
import { importZipWithProgress, getTags } from '../api/documents';
import TagChipInput from '../components/shared/TagChipInput';
import StandaloneCardModal from '../components/shared/StandaloneCardModal';
import ProgressDialog from '../components/shared/ProgressDialog';
import { LoadingState, ErrorState } from '../components/shared/StateView';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { useDataInvalidation, invalidateData } from '../utils/dataBus';
import './Decks.css';

// ── Hooks ────────────────────────────────────────────────────────────────────

function useDecks() {
    const [decks, setDecks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const refresh = useCallback(() => {
        setLoading(true);
        setError(null);
        // The system deck is the home for every standalone card, so it always
        // leads the list; other decks keep the order the API returns them in.
        listDecks()
            .then(list => setDecks([...list].sort((a, b) => (b.is_system ? 1 : 0) - (a.is_system ? 1 : 0))))
            .catch(setError)
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { refresh(); }, [refresh]);
    return { decks, loading, error, refresh };
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

// ── DeckTags ─────────────────────────────────────────────────────────────────

function DeckTags({ deckHash, tags, onChanged }) {
    const [allTags, setAllTags] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        getTags().then(({ tags: all }) => setAllTags(all ?? [])).catch(() => {});
    }, []);

    const save = async (next) => {
        setSaving(true);
        try { await setDeckTags(deckHash, next); onChanged(); }
        catch (err) { console.error(err); }
        finally { setSaving(false); }
    };

    const addTag = (name) => { if (!tags.includes(name)) save([...tags, name]); };
    const removeTag = (name) => save(tags.filter(t => t !== name));

    return (
        <div className="deck-tags" aria-busy={saving}>
            <span className="deck-tags-label">Tags</span>
            <TagChipInput
                tags={tags}
                onAdd={addTag}
                onRemove={removeTag}
                allKnownTags={allTags}
                placeholder="Add a tag…"
                chipClass="tag-chip--direct"
            />
            <span className="deck-tags-hint">Tags flow down to every card in this deck.</span>
        </div>
    );
}

// ── DeckDetail ───────────────────────────────────────────────────────────────

function DeckDetail({ deckHash, onDeleted, onRefreshList, onStudy }) {
    const confirm = useConfirm();
    const [deck, setDeck] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showAddPanel, setShowAddPanel] = useState(false);
    const [showNewCard, setShowNewCard] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [renameVal, setRenameVal] = useState('');

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        getDeck(deckHash)
            .then(d => setDeck(d))
            .catch(setError)
            .finally(() => setLoading(false));
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
        const ok = await confirm({
            title: `Delete "${deck.name}"?`,
            message: 'This removes the deck. The cards themselves are not deleted.',
            confirmLabel: 'Delete deck',
            tone: 'danger',
        });
        if (!ok) return;
        try { await deleteDeck(deckHash); onDeleted(); }
        catch (err) { setError(err); }
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
        <div className="deck-content"><LoadingState message="Loading deck…" /></div>
    );
    if (error) return (
        <div className="deck-content"><ErrorState error={error} title="Couldn't load this deck" onRetry={load} /></div>
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
                        {!!deck.is_system && <span className="deck-system-badge deck-system-badge--detail">Standalone cards live here</span>}
                    </div>
                </div>
                <div className="deck-detail-actions">
                    {deck.entries?.length > 0 && (
                        <button type="button" className="deck-btn primary" onClick={() => onStudy(deck)}>▶ Study</button>
                    )}
                    {!!deck.is_system && (
                        <button type="button" className="deck-btn" onClick={() => setShowNewCard(true)}>+ New card</button>
                    )}
                    <button type="button" className="deck-btn" onClick={() => setShowAddPanel(v => !v)}>+ Add cards</button>
                    {!deck.is_system && (
                        <button type="button" className="deck-btn danger" onClick={handleDelete}>Delete</button>
                    )}
                </div>
            </div>

            <DeckTags deckHash={deckHash} tags={deck.tags || []}
                onChanged={() => { load(); onRefreshList(); }} />

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

export default function DecksView({ onStudyDeck, openDeck, onOpenDeckConsumed }) {
    const { decks, loading, error, refresh } = useDecks();
    const [activeDeck, setActiveDeck] = useState(null);

    // A deck opened from global search: select it and clear the request.
    useEffect(() => {
        if (!openDeck) return;
        setActiveDeck(openDeck);
        setCreating(false);
        onOpenDeckConsumed?.();
    }, [openDeck, onOpenDeckConsumed]);
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(null); // null | { pct, processing, filename }
    const [importError, setImportError] = useState(null);
    const [importVersion, setImportVersion] = useState(0); // bumped after each import to force DeckDetail to reload
    const importInputRef = useRef(null);

    // A Seal rollback / Vault Doctor sync rewrote the deck index — reload the deck
    // list and remount the open deck detail (importVersion is part of its key).
    useDataInvalidation(() => { refresh(); setImportVersion(v => v + 1); });

    const handleCreated = (hash) => { setCreating(false); refresh(); setActiveDeck(hash); };
    const handleDeleted = () => { setActiveDeck(null); refresh(); };
    const handleStudy = (deck) => onStudyDeck?.({ deck: deck.global_hash, deckName: deck.name });

    const handleImportFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-selecting the same file re-triggers change
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('name', file.name);
        fd.append('targetPath', '');
        setImporting({ pct: 0, processing: false, filename: file.name });
        setImportError(null);
        try {
            await importZipWithProgress(fd, (pct) =>
                setImporting({ pct, processing: pct >= 100, filename: file.name })
            );
            // Broadcast so every DB-backed view (this deck list, Flashcards, the
            // file tree, the graph) reloads — not just this one. Our own
            // useDataInvalidation subscriber handles refresh() + importVersion bump.
            invalidateData();
        } catch (err) {
            console.error('Import failed', err);
            setImportError(`Couldn't import "${file.name}". ${err.message || 'The file may be unsupported or corrupt.'}`);
        } finally {
            setImporting(null);
        }
    };

    return (
        <div className="decks-view">
            <div className="decks-panel">
                <div className="decks-panel-header">
                    <span className="decks-panel-title">Decks</span>
                    <div className="decks-panel-actions">
                        <button type="button" className="decks-panel-import" title="Import an Anki deck (.apkg) or Obsidian vault (.zip)"
                            onClick={() => importInputRef.current?.click()} aria-label="Import deck">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                                <path d="M12 12L8 8L4 12"/>
                                <line x1="8" y1="8" x2="8" y2="15"/>
                                <rect x="2" y="2" width="12" height="4" rx="1"/>
                            </svg>
                        </button>
                        <button type="button" className="decks-panel-new" title="New deck" onClick={() => { setCreating(true); setActiveDeck(null); }}>+</button>
                    </div>
                    <input
                        ref={importInputRef}
                        type="file"
                        accept=".apkg,.zip"
                        style={{ display: 'none' }}
                        onChange={handleImportFile}
                    />
                </div>

                <div className="decks-list">
                    {loading && <div className="decks-empty">Loading…</div>}
                    {!loading && error && (
                        <div className="decks-empty decks-empty--error">
                            <span>Failed to load decks.</span>
                            <button type="button" className="decks-retry" onClick={refresh}>Try again</button>
                        </div>
                    )}
                    {!loading && !error && decks.length === 0 && !creating && (
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
                    <DeckDetail key={`${activeDeck}:${importVersion}`} deckHash={activeDeck}
                        onDeleted={handleDeleted} onRefreshList={refresh} onStudy={handleStudy} />
                ) : (
                    <div className="deck-empty-state">
                        <div className="deck-empty-icon">▤</div>
                        <div className="deck-empty-text">Select a deck or create a new one to get started.</div>
                    </div>
                )}
            </div>
            {importing && (
                <ProgressDialog
                    title="Importing deck"
                    filename={importing.filename}
                    progress={importing.pct}
                    processing={importing.processing}
                    statusText={importing.processing ? 'Processing…' : `Uploading… ${importing.pct}%`}
                />
            )}
            {importError && (
                <div className="decks-import-error" role="alert">
                    <span>{importError}</span>
                    <button type="button" onClick={() => setImportError(null)} aria-label="Dismiss">×</button>
                </div>
            )}
        </div>
    );
}
