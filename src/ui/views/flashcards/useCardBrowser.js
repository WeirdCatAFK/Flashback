/**
 * The card browser's state: the filters, the debounced paged search they drive,
 * the level statistics in the sidebar, and deleting a card. Any filter change
 * returns to the first page.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { getStats } from '../../api/srs';
import { searchCards, deleteCard } from '../../api/decks';
import { useConfirm } from '../../components/base/confirmContext.js';
import { useDataInvalidation } from '../../utils/dataBus';
import { useT } from '../../translations/index';
import { PAGE_SIZE, searchArgsFor, hasFilters } from './filters.js';

const TYPE_DEBOUNCE = 250;

export default function useCardBrowser() {
  const { t } = useT();
  const confirm = useConfirm();
  const [stats, setStats] = useState(null);
  const [statsToken, setStatsToken] = useState(0);
  const [filters, setFilters] = useState({ query: '', level: null, cardType: null, flagFilter: null, sort: 'level:desc' });
  const [page, setPage] = useState(0);
  const [cards, setCards] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => { getStats().then(setStats).catch(() => {}); }, [statsToken]);

  const searchArgs = searchArgsFor(filters);
  const searchKey = JSON.stringify(searchArgs);

  const loadCards = useCallback((args, pg) => {
    setLoading(true);
    setError(null);
    searchCards({ ...args, limit: PAGE_SIZE, offset: pg * PAGE_SIZE })
      .then((res) => { setCards(res.cards); setTotal(res.total); })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadCards(JSON.parse(searchKey), page), filters.query ? TYPE_DEBOUNCE : 0);
  }, [searchKey, page, filters.query, loadCards]);

  const reload = () => loadCards(searchArgs, page);
  const reloadAll = () => { reload(); setStatsToken((n) => n + 1); };
  useDataInvalidation(reloadAll);

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(0);
  };
  const toggleFilter = (key, value) => setFilter(key, filters[key] === value ? null : value);

  const remove = async (card) => {
    const ok = await confirm({
      title: t('Delete this card?'),
      message: card.document_name
        ? t('This permanently removes the card from {document}, including its review history. The document itself is untouched. This cannot be undone.', { document: card.document_name })
        : t('This permanently removes the standalone card, including its review history. This cannot be undone.'),
      confirmLabel: t('Delete card'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await deleteCard(card.global_hash);
      reload();
    } catch (err) {
      setError(err);
    }
  };

  return {
    stats, filters, page, cards, total, loading, error,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filtered: hasFilters(filters),
    setFilter, toggleFilter, setPage, reload, reloadAll, remove,
    clearFilters: () => { setFilters((f) => ({ ...f, query: '', level: null, cardType: null, flagFilter: null })); setPage(0); },
  };
}
