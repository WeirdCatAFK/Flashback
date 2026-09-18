/**
 * The Manage view's data: the pedagogical categories with their CRUD, and the
 * vault's tags with how often each is applied. Both reload on demand and when
 * the tab becomes active.
 */

import { useState, useEffect, useCallback } from 'react';
import { getCategories, createCategory, updateCategory, deleteCategory } from '../../api/categories';
import { getTagUsage } from '../../api/tags';

const EMPTY_DRAFT = { name: '', priority: 0, description: '' };

export function useCategories(refreshKey) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    getCategories()
      .then((c) => { setCategories(c); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  const save = (id, data) => {
    if (data.name !== undefined && !data.name.trim()) return;
    updateCategory(id, data).then(reload);
  };

  const remove = (id) => {
    setDeleteError(null);
    deleteCategory(id).then(reload).catch((err) => setDeleteError(err.message));
  };

  const add = () => {
    if (!draft.name.trim()) return;
    setAdding(true);
    createCategory({ name: draft.name.trim(), priority: Number(draft.priority) || 0, description: draft.description })
      .then(() => { setDraft(EMPTY_DRAFT); reload(); })
      .finally(() => setAdding(false));
  };

  return {
    categories, error, deleteError, draft, adding, reload, save, remove, add,
    firstLoad: loading && categories.length === 0,
    setDraftField: (key, value) => setDraft((d) => ({ ...d, [key]: value })),
  };
}

export function useTagUsage(refreshKey) {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    getTagUsage()
      .then((list) => { setTags(list); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  const q = filter.trim().toLowerCase();
  return {
    tags, error, filter, setFilter, reload,
    shown: q ? tags.filter((tag) => tag.name.toLowerCase().includes(q)) : tags,
    firstLoad: loading && tags.length === 0,
  };
}
