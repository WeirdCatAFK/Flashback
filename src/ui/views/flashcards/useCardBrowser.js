/**
 * The Flashcards catalogue's state: the view (search, source, band, health, type,
 * order, grouping), the debounced search it drives with "show more" paging, the
 * sidebar summary, and opening a card's document. Everything reloads when the
 * screen comes back into view, since a study session elsewhere moves cards between
 * bands. The card editor's state is useCardBench's.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { searchCards, getCatalogueSummary } from '../../api/decks';
import { readFile } from '../../api/documents';
import { getPref } from '../../prefs.js';
import { useDataInvalidation } from '../../utils/dataBus';
import { PAGE_SIZE, EMPTY_VIEW, NO_NARROWING, searchArgsFor, isNarrowed, ancestorsOf } from './catalogue.js';

const TYPE_DEBOUNCE = 250;

const algorithmPref = () => getPref('fb-srs-algorithm') ?? 'sm2';

export default function useCardBrowser({ isActive, onOpenSource }) {
  const [view, setView] = useState(EMPTY_VIEW);
  const [openFolders, setOpenFolders] = useState(() => new Set());
  const [pages, setPages] = useState(1);
  const [result, setResult] = useState({ cards: [], total: 0, groups: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [token, setToken] = useState(0);
  const debounceRef = useRef(null);
  const requestRef = useRef(0);

  const algorithm = algorithmPref();
  const args = searchArgsFor(view, algorithm);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    if (!isActive) return;
    getCatalogueSummary(algorithmPref()).then(setSummary).catch(() => {});
  }, [isActive, token]);

  useEffect(() => {
    if (!isActive) return undefined;
    clearTimeout(debounceRef.current);
    const id = ++requestRef.current;
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchCards({ ...JSON.parse(argsKey), limit: pages * PAGE_SIZE, offset: 0 })
        .then((res) => { if (id === requestRef.current) setResult({ cards: res.cards, total: res.total, groups: res.groups ?? null }); })
        .catch((err) => { if (id === requestRef.current) setError(err); })
        .finally(() => { if (id === requestRef.current) setLoading(false); });
    }, view.query ? TYPE_DEBOUNCE : 0);
    return () => clearTimeout(debounceRef.current);
  }, [argsKey, pages, view.query, isActive, token]);

  const reload = useCallback(() => setToken((n) => n + 1), []);
  useDataInvalidation(reload);

  const update = (patch) => {
    setView((v) => ({ ...v, ...patch }));
    setPages(1);
  };

  const chooseSource = (source) => {
    const same = source && view.source?.kind === source.kind && view.source?.path === source.path;
    update({ source: same ? null : source });
    if (source?.kind === 'folder' || source?.kind === 'document') {
      setOpenFolders((prev) => new Set([...prev, ...ancestorsOf(source.path), ...(source.kind === 'folder' ? [source.path] : [])]));
    }
  };

  const toggleFolder = (path) => setOpenFolders((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  /** Opens the card's document at the passage it was made from, when it has one. */
  const openSource = async (row) => {
    if (!row.document_path) return;
    let highlightId = null;
    try {
      const data = await readFile(row.document_path);
      const loc = data.metadata?.flashcards?.find((c) => c.globalHash === row.global_hash)?.vanillaData?.location;
      if (loc?.type === 'highlight') highlightId = loc.id;
    } catch { }
    onOpenSource?.(row.document_path, highlightId);
  };

  return {
    view, update, chooseSource, openFolders, toggleFolder,
    cards: result.cards, total: result.total, groups: result.groups,
    loading, error, summary, reload,
    narrowed: isNarrowed(view),
    clear: () => update(NO_NARROWING),
    hasMore: result.cards.length < result.total,
    showMore: () => setPages((n) => n + 1),
    openSource,
  };
}
