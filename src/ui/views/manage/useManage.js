/**
 * Metadata's data: the categories (each with its card count), the tags with their reach,
 * and how many cards the vault has, loaded together whenever the screen is shown. The
 * mutations reload what they change. A level move redraws at once and writes only the
 * categories whose priority changes (metadata.js); a failed write reloads the truth.
 */

import { useState, useEffect, useCallback } from 'react';
import { getCategories, createCategory, updateCategory, deleteCategory } from '../../api/categories';
import { getTagOverview, renameTag, removeTag } from '../../api/tags';
import { searchCards } from '../../api/decks';
import { placeCategory, newCategoryPriority, withPriorities } from './metadata.js';

export default function useManage(isActive) {
  const [categories, setCategories] = useState(null);
  const [tags, setTags] = useState(null);
  const [totalCards, setTotalCards] = useState(0);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const reload = useCallback(() => Promise.all([getCategories(), getTagOverview(), searchCards({ limit: 1 })])
    .then(([cats, tagList, page]) => {
      setCategories(cats);
      setTags(tagList);
      setTotalCards(page?.total ?? 0);
      setError(null);
    })
    .catch((e) => setError(e.message)), []);

  useEffect(() => { if (isActive) reload(); }, [isActive, reload]);

  /** Runs a mutation, reloads, and reports whether it worked; the message stays on screen until the next action. */
  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setActionError(e.message);
      await reload();
      return false;
    }
  };

  const moveCategory = (id, target) => {
    const changes = placeCategory(categories ?? [], id, target);
    if (!changes.length) return Promise.resolve(true);
    setCategories((cats) => withPriorities(cats, changes));
    return run(() => Promise.all(changes.map((c) => updateCategory(c.id, { priority: c.priority }))));
  };

  return {
    categories,
    tags,
    totalCards,
    error,
    actionError,
    reload,
    firstLoad: categories === null || tags === null,
    addCategory: ({ name, description }) =>
      run(() => createCategory({ name, description, priority: newCategoryPriority(categories ?? []) })),
    saveCategory: (id, { name, description }) => run(() => updateCategory(id, { name, description })),
    deleteCategory: (id) => run(() => deleteCategory(id, { clear: true })),
    moveCategory,
    renameTag: (from, to) => run(() => renameTag(from, to)),
    removeTag: (from) => run(() => removeTag(from)),
  };
}
