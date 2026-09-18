/**
 * The search palette's state: the debounced query, its results, the keyboard
 * cursor over the flat list, and navigating to the chosen result.
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { superSearch } from '../../api/search';
import { parseQuery, isEmptyPrefix, flattenResults, groupResults, navigationFor } from './search.js';

const DEBOUNCE = 200;

export default function useSearch({ onNavigate, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const debounceRef = useRef(null);

  const flatItems = useMemo(() => flattenResults(results), [results]);
  const groups = useMemo(() => groupResults(results), [results]);

  const doSearch = useCallback(async (raw) => {
    const trimmed = raw.trim();
    const parsed = parseQuery(trimmed);
    if (!trimmed || isEmptyPrefix(parsed)) { setResults(null); setLoading(false); return; }
    setLoading(true);
    setError(false);
    try {
      const { q, tag, deck, document, folder } = parsed;
      setResults(await superSearch({ q, tag, deck, document, folder }));
      setFocusIdx(0);
    } catch (err) {
      console.error(err);
      setError(true);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const change = (val) => {
    setQuery(val);
    setLoading(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), DEBOUNCE);
  };

  const navigate = useCallback((item) => {
    const target = navigationFor(item);
    if (target) onNavigate(target);
    onClose();
  }, [onNavigate, onClose]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, flatItems.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flatItems[focusIdx]) navigate(flatItems[focusIdx]); }
  };

  return {
    query, results, loading, error, focusIdx, setFocusIdx, flatItems, groups,
    parsed: parseQuery(query),
    isEmpty: !!results && flatItems.length === 0,
    change, navigate, onKeyDown,
  };
}
