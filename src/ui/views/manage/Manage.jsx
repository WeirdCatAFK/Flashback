/**
 * Manage — the vault-wide vocabulary: pedagogical categories (priority, name,
 * description, edited in place) and every tag with its usage count. Data and
 * mutations live in useManage.js.
 */

import { useState, useEffect } from 'react';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import { useT } from '../../translations/index';
import { useSession } from '../../sessionContext.js';
import { useCategories, useTagUsage } from './useManage';
import './Manage.css';

function SectionHead({ title, count, hint }) {
  return (
    <div className="mng-section-head">
      <h2 className="eyebrow mng-section-label">
        {title}
        {count > 0 && <span className="badge mng-count">{count}</span>}
      </h2>
      <p className="muted mng-section-hint">{hint}</p>
    </div>
  );
}

function CategoryRow({ cat, onSave, onDelete, readOnly }) {
  const { t } = useT();
  const [name, setName] = useState(cat.name);
  const [priority, setPriority] = useState(cat.priority);
  const [description, setDescription] = useState(cat.description ?? '');

  useEffect(() => { setName(cat.name); }, [cat.name]);
  useEffect(() => { setPriority(cat.priority); }, [cat.priority]);
  useEffect(() => { setDescription(cat.description ?? ''); }, [cat.description]);

  return (
    <tr className="mng-cat-row">
      <td>
        <input type="number" className="field field--sm mng-input--priority" value={priority} min={0} max={99} onChange={(e) => setPriority(e.target.value)} onBlur={() => onSave(cat.id, { priority: Number(priority) })} aria-label={t('Priority')} readOnly={readOnly} />
      </td>
      <td>
        <input type="text" className="field field--sm" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => onSave(cat.id, { name })} aria-label={t('Category name')} maxLength={200} readOnly={readOnly} />
      </td>
      <td>
        <input type="text" className="field field--sm" value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => onSave(cat.id, { description })} aria-label={t('Description')} maxLength={500} readOnly={readOnly} />
      </td>
      <td>
        {!readOnly && (
          <button type="button" className="btn-close" onClick={() => onDelete(cat.id)} title={t('Delete category')} aria-label={t('Delete {name}', { name: cat.name })}>×</button>
        )}
      </td>
    </tr>
  );
}

function CategoriesPanel({ refreshKey }) {
  const { t } = useT();
  const { can } = useSession();
  const mayEdit = can('manageCategories');
  const c = useCategories(refreshKey);
  const onEnter = (e) => { if (e.key === 'Enter') c.add(); };

  return (
    <section className="mng-section">
      <SectionHead title={t('Pedagogical categories')} count={c.categories.length} hint={t('Classify each card by its learning purpose — definition, concept, application… Lower priority is studied first.')} />
      {c.firstLoad ? (
        <LoadingState message={t('Loading categories…')} />
      ) : c.error && c.categories.length === 0 ? (
        <ErrorState error={c.error} onRetry={c.reload} />
      ) : (
        <table className="mng-table">
          <thead>
            <tr>
              <th className="mng-th mng-th--priority">{t('Priority')}</th>
              <th className="mng-th">{t('Name')}</th>
              <th className="mng-th">{t('Description')}</th>
              <th className="mng-th mng-th--action" />
            </tr>
          </thead>
          <tbody>
            {c.categories.map((cat) => <CategoryRow key={cat.id} cat={cat} onSave={c.save} onDelete={c.remove} readOnly={!mayEdit} />)}
            {mayEdit && (
              <tr className="mng-cat-row mng-add-row">
                <td>
                  <input type="number" className="field field--sm mng-input--priority" value={c.draft.priority} min={0} max={99} onChange={(e) => c.setDraftField('priority', e.target.value)} aria-label={t('New category priority')} />
                </td>
                <td>
                  <input type="text" className="field field--sm" placeholder={t('New category…')} value={c.draft.name} onChange={(e) => c.setDraftField('name', e.target.value)} onKeyDown={onEnter} aria-label={t('New category name')} maxLength={200} />
                </td>
                <td>
                  <input type="text" className="field field--sm" placeholder={t('Description…')} value={c.draft.description} onChange={(e) => c.setDraftField('description', e.target.value)} onKeyDown={onEnter} aria-label={t('New category description')} maxLength={500} />
                </td>
                <td>
                  <button type="button" className="btn btn--primary btn--sm" onClick={c.add} disabled={!c.draft.name.trim() || c.adding}>{t('Add')}</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {c.deleteError && <p className="mng-error">{c.deleteError}</p>}
    </section>
  );
}

function TagsPanel({ refreshKey }) {
  const { t, tp } = useT();
  const u = useTagUsage(refreshKey);

  return (
    <section className="mng-section">
      <SectionHead title={t('Tags')} count={u.tags.length} hint={t('Every tag in your vault and how many items apply it directly. Tags are added or removed at the head of a document, or on a folder from its menu in the file tree, and inherit down the folder tree.')} />
      {u.firstLoad ? (
        <LoadingState message={t('Loading tags…')} />
      ) : u.error && u.tags.length === 0 ? (
        <ErrorState error={u.error} onRetry={u.reload} />
      ) : u.tags.length === 0 ? (
        <p className="mng-empty">{t('No tags yet. Add tags at the head of a document, or to a folder from the file tree, and they will appear here.')}</p>
      ) : (
        <>
          <input type="search" className="field mng-tag-filter" placeholder={t('Filter tags…')} value={u.filter} onChange={(e) => u.setFilter(e.target.value)} aria-label={t('Filter tags')} />
          {u.shown.length === 0 ? (
            <p className="mng-empty">{t('No tags match “{query}”.', { query: u.filter })}</p>
          ) : (
            <ul className="mng-tag-list">
              {u.shown.map((tag) => (
                <li key={tag.name} className="chip chip--muted mng-tag-chip" title={tp('{n} item', '{n} items', tag.count)}>
                  <span className="mng-tag-name">{tag.name}</span>
                  <span className="mng-tag-count">{tag.count}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export default function Manage({ isActive }) {
  const { t } = useT();
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => { if (isActive) setRefreshKey((k) => k + 1); }, [isActive]);

  return (
    <div className="mng-view">
      <div className="mng-body">
        <header className="mng-header">
          <h1 className="mng-title">{t('Management')}</h1>
          <p className="mng-lede">{t('Categories and tags that shape how your whole vault is classified and studied.')}</p>
        </header>
        <CategoriesPanel refreshKey={refreshKey} />
        <TagsPanel refreshKey={refreshKey} />
      </div>
    </div>
  );
}
