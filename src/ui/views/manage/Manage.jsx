/**
 * Metadata — the vocabulary a vault classifies its cards with, read as a short report in
 * two tabs.
 *
 * Categories sit on priority levels, several to a level: when the Trainer studies by
 * priority, level 1 comes first. A category is dragged onto another level (or onto "new
 * level" above or below the rest), or moved with Raise and Lower (Alt+↑/↓ on a focused
 * row); the levels renumber with no gaps (metadata.js). Deleting one says what happens to
 * its cards before it happens: they stay, without a category.
 *
 * Tags are rows with their reach (where they are applied, and how many cards carry them),
 * renamed or removed everywhere at once. They are applied on files, folders and decks, not
 * here.
 *
 * Clicking a row opens its cards in Flashcards (`onShowCards`). Editing is gated by
 * `manageCategories` and `manageTags`; a reader sees the same report without the actions.
 * Data and mutations are in useManage.js.
 */

import { useState } from 'react';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import { useT } from '../../translations/index';
import { useSession } from '../../sessionContext.js';
import { cleanTagName } from '../../../shared/tagNames.js';
import { tiersOf, shiftTarget, reachOf, shownTags, uncategorized } from './metadata.js';
import useManage from './useManage';
import './Manage.css';

/** Six dots: the handle a category is dragged by. */
const Grip = () => (
  <svg viewBox="0 0 10 14" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="3" cy="3" r="1.1" /><circle cx="7" cy="3" r="1.1" />
      <circle cx="3" cy="7" r="1.1" /><circle cx="7" cy="7" r="1.1" />
      <circle cx="3" cy="11" r="1.1" /><circle cx="7" cy="11" r="1.1" />
    </g>
  </svg>
);

/** Keys shared by every inline form: Enter commits, Escape backs out. */
const formKeys = (onSubmit, onCancel) => (e) => {
  if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
};

/** Stops a row action's click from also opening the row's cards. */
const only = (fn) => (e) => { e.stopPropagation(); fn(); };

function CategoryForm({ initial, adding, onSave, onCancel }) {
  const { t } = useT();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const submit = () => { if (name.trim()) onSave({ name: name.trim(), description: description.trim() }); };
  const keys = formKeys(submit, onCancel);
  return (
    <div className="mt-row is-editing">
      <div className="mt-fields">
        <input className="field field--sm" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys}
          aria-label={t('Name')} placeholder={t('Name, e.g. Formula')} maxLength={200} autoFocus />
        <input className="field field--sm" value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={keys}
          aria-label={t('Description')} placeholder={t('What it’s for')} maxLength={500} />
      </div>
      <span className="mt-acts is-on">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="btn btn--quiet-accent btn--sm" onClick={submit} disabled={!name.trim()}>{adding ? t('Add') : t('Save')}</button>
      </span>
    </div>
  );
}

function Confirm({ title, detail, keepLabel, goLabel, onKeep, onGo }) {
  return (
    <div className="mt-row is-confirming" role="group" aria-label={title}>
      <div className="mt-text">
        <span className="mt-name">{title}</span>
        <span className="mt-desc">{detail}</span>
      </div>
      <span className="mt-acts is-on">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onKeep} autoFocus>{keepLabel}</button>
        <button type="button" className="btn btn--danger-quiet btn--sm" onClick={onGo}>{goLabel}</button>
      </span>
    </div>
  );
}

function Categories({ m, mayEdit, onShowCards }) {
  const { t, tp, formatNumber } = useT();
  const cats = m.categories;
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dropOn, setDropOn] = useState(null);
  const tiers = tiersOf(cats);
  const none = uncategorized(m.totalCards, cats);
  const total = Math.max(1, m.totalCards);

  const idle = () => { setEditing(null); setAdding(false); setConfirming(null); };
  const move = (id, target) => { if (target) m.moveCategory(id, target); };
  const show = (c) => onShowCards?.({ category: { id: c.id, name: c.name } });

  const dropZone = (key, onDrop) => ({
    onDragOver: (e) => { if (dragId === null) return; e.preventDefault(); if (dropOn !== key) setDropOn(key); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOn((k) => (k === key ? null : k)); },
    onDrop: (e) => { if (dragId === null) return; e.preventDefault(); onDrop(dragId); setDragId(null); setDropOn(null); },
  });

  const row = (c) => {
    if (editing === c.id) {
      return (
        <CategoryForm key={c.id} initial={c}
          onSave={async (data) => { if (await m.saveCategory(c.id, data)) setEditing(null); }}
          onCancel={() => setEditing(null)} />
      );
    }
    if (confirming === c.id) {
      return (
        <Confirm key={c.id}
          title={t('Delete “{name}”?', { name: c.name })}
          detail={c.cards
            ? tp('{n} card loses this category; the card stays.', '{n} cards lose this category; the cards stay.', c.cards, { n: formatNumber(c.cards) })
            : t('No card uses it.')}
          keepLabel={t('Keep it')} goLabel={t('Delete')}
          onKeep={() => setConfirming(null)}
          onGo={async () => { await m.deleteCategory(c.id); setConfirming(null); }} />
      );
    }
    const up = mayEdit ? shiftTarget(cats, c.id, -1) : null;
    const down = mayEdit ? shiftTarget(cats, c.id, 1) : null;
    return (
      <div
        key={c.id}
        className={`mt-row is-cat${dragId === c.id ? ' is-dragging' : ''}`}
        role="listitem"
        tabIndex={0}
        draggable={mayEdit}
        title={mayEdit ? t('Drag to another level. Click to see these cards in Flashcards') : t('See these cards in Flashcards')}
        onClick={() => show(c)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') { e.preventDefault(); show(c); }
          if (mayEdit && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            move(c.id, e.key === 'ArrowUp' ? up : down);
          }
        }}
        onDragStart={(e) => {
          setTimeout(() => setDragId(c.id));
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(c.id)); } catch {}
        }}
        onDragEnd={() => { setDragId(null); setDropOn(null); }}
      >
        {mayEdit && <span className="mt-grip" aria-hidden="true"><Grip /></span>}
        <div className="mt-text">
          <span className="mt-name">{c.name}</span>
          <span className="mt-desc">{c.description || t('No description.')}</span>
          <span className="mt-share" aria-hidden="true"><i style={{ width: `${Math.round(((c.cards ?? 0) / total) * 100)}%` }} /></span>
        </div>
        <span className="mt-count">{tp('{n} card', '{n} cards', c.cards ?? 0, { n: formatNumber(c.cards ?? 0) })}</span>
        {mayEdit && (
          <span className="mt-acts">
            <button type="button" className="link-action" disabled={!up} onClick={only(() => move(c.id, up))}
              title={up === 'top' ? t('Give it a level of its own, above the rest') : t('Move to the level above')}>{t('Raise')}</button>
            <button type="button" className="link-action" disabled={!down} onClick={only(() => move(c.id, down))}
              title={down === 'bottom' ? t('Give it a level of its own, below the rest') : t('Move to the level below')}>{t('Lower')}</button>
            <button type="button" className="link-action" onClick={only(() => { idle(); setEditing(c.id); })}>{t('Edit')}</button>
            <button type="button" className="link-action link-action--danger" onClick={only(() => { idle(); setConfirming(c.id); })}>{t('Delete')}</button>
          </span>
        )}
      </div>
    );
  };

  const newForm = adding && (
    <CategoryForm key="new" adding initial={{ name: '', description: '' }}
      onSave={async (data) => { if (await m.addCategory(data)) setAdding(false); }}
      onCancel={() => setAdding(false)} />
  );

  return (
    <div className={dragId !== null ? 'is-dragging-cat' : undefined}>
      <p className="mt-p">
        {t('What each card is for. Categories sit on priority levels, and several can share one: when the Trainer studies by priority, the cards on level 1 come first, then level 2, and so on.')}
        {mayEdit && ` ${t('Drag a category to another level, or use Raise and Lower.')}`}
      </p>
      {mayEdit && (
        <div className={`mt-newlevel${dropOn === 'top' ? ' is-drop' : ''}`} {...dropZone('top', (id) => move(id, 'top'))}>
          {t('New level, studied first')}
        </div>
      )}
      <div className="mt-tiers">
        {tiers.map((tier, k) => (
          <section key={tier.priority} className={`mt-tier${dropOn === tier.priority ? ' is-drop' : ''}`}
            aria-label={t('Level {n}', { n: k + 1 })} {...dropZone(tier.priority, (id) => move(id, { level: tier.priority }))}>
            <div className="mt-tier-head">
              <span className="mt-tier-name">
                {t('Level {n}', { n: k + 1 })}
                {tiers.length > 1 && k === 0 && ` · ${t('studied first')}`}
                {tiers.length > 1 && k === tiers.length - 1 && ` · ${t('studied last')}`}
              </span>
              <span className="mt-tier-n">{tp('{n} category', '{n} categories', tier.members.length, { n: formatNumber(tier.members.length) })}</span>
            </div>
            <div role="list">
              {tier.members.map(row)}
              {k === tiers.length - 1 && newForm}
            </div>
          </section>
        ))}
        {tiers.length === 0 && (newForm || <p className="mt-empty">{t('No categories yet.')}</p>)}
      </div>
      {mayEdit && (
        <div className={`mt-newlevel${dropOn === 'bottom' ? ' is-drop' : ''}`} {...dropZone('bottom', (id) => move(id, 'bottom'))}>
          {t('New level, studied last')}
        </div>
      )}
      <div className="mt-foot">
        {mayEdit && !adding && (
          <button type="button" className="mt-add" onClick={() => { idle(); setAdding(true); }}>{t('+ New category')}</button>
        )}
        <span className="mt-note">
          {none
            ? tp('{n} card has no category yet.', '{n} cards have no category yet.', none, { n: formatNumber(none) })
            : t('Every card has a category.')}
        </span>
      </div>
    </div>
  );
}

function Tags({ m, mayEdit, onShowCards }) {
  const { t, tp, formatNumber } = useT();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('use');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(null);
  const shown = shownTags(m.tags, query, sort);

  const KIND = {
    folder: (n) => tp('{n} folder', '{n} folders', n, { n: formatNumber(n) }),
    document: (n) => tp('{n} document', '{n} documents', n, { n: formatNumber(n) }),
    deck: (n) => tp('{n} deck', '{n} decks', n, { n: formatNumber(n) }),
    card: (n) => tp('{n} card directly', '{n} cards directly', n, { n: formatNumber(n) }),
  };
  const reach = (tag) => reachOf(tag).map(([kind, n]) => KIND[kind](n)).join(' · ') || t('not applied anywhere');
  const show = (tag) => onShowCards?.({ tag: tag.name });

  const startRename = (tag) => { setConfirming(null); setEditing(tag.name); setDraft(tag.name); };
  const commitRename = async (tag) => {
    const to = cleanTagName(draft);
    if (!to || to === tag.name) { setEditing(null); return; }
    if (await m.renameTag(tag.name, to)) setEditing(null);
  };

  const row = (tag) => {
    if (editing === tag.name) {
      const to = cleanTagName(draft);
      const merges = to && to !== tag.name && m.tags.some((x) => x.name === to);
      return (
        <div key={tag.name} className="mt-row is-editing">
          <span className="mt-hash" aria-hidden="true">#</span>
          <div className="mt-fields is-one">
            <input className="field field--sm" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
              onKeyDown={formKeys(() => commitRename(tag), () => setEditing(null))}
              aria-label={t('New name for #{name}', { name: tag.name })} />
          </div>
          <span className="mt-acts is-on">
            <span className="mt-note">
              {merges ? t('#{name} exists already; the two become one.', { name: to }) : t('Renames it on {reach}', { reach: reach(tag) })}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>{t('Cancel')}</button>
            <button type="button" className="btn btn--quiet-accent btn--sm" onClick={() => commitRename(tag)}>{t('Rename')}</button>
          </span>
        </div>
      );
    }
    if (confirming === tag.name) {
      return (
        <Confirm key={tag.name}
          title={t('Remove #{name}?', { name: tag.name })}
          detail={`${t('Removes it from {reach}.', { reach: reach(tag) })} ${tp('{n} card loses it.', '{n} cards lose it.', tag.cards, { n: formatNumber(tag.cards) })} ${t('The cards and files stay.')}`}
          keepLabel={t('Keep it')} goLabel={t('Remove')}
          onKeep={() => setConfirming(null)}
          onGo={async () => { await m.removeTag(tag.name); setConfirming(null); }} />
      );
    }
    return (
      <div key={tag.name} className="mt-row is-tag" role="listitem" tabIndex={0}
        title={t('See these cards in Flashcards')}
        onClick={() => show(tag)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); show(tag); } }}>
        <span className="mt-hash" aria-hidden="true">#</span>
        <div className="mt-text">
          <span className="mt-name">{tag.name}</span>
          <span className="mt-desc">{reach(tag)}</span>
        </div>
        <span className="mt-count">{tp('{n} card', '{n} cards', tag.cards, { n: formatNumber(tag.cards) })}</span>
        <span className="mt-acts">
          <button type="button" className="link-action" onClick={only(() => show(tag))}>{t('Show cards')}</button>
          {mayEdit && <button type="button" className="link-action" onClick={only(() => startRename(tag))}>{t('Rename')}</button>}
          {mayEdit && (
            <button type="button" className="link-action link-action--danger" onClick={only(() => { setEditing(null); setConfirming(tag.name); })}>{t('Remove')}</button>
          )}
        </span>
      </div>
    );
  };

  return (
    <>
      <p className="mt-p">
        {t('Tags are added on a file, a folder or a deck, and flow down to everything inside it. Here you can see where each one reaches and open its cards.')}
        {mayEdit && ` ${t('A rename or a removal applies everywhere at once.')}`}
      </p>
      {m.tags.length === 0 ? (
        <p className="mt-empty">{t('No tags yet. Add them at the head of a document, on a folder from the file tree, or on a deck.')}</p>
      ) : (
        <>
          <div className="mt-tagbar">
            <input type="search" className="field field--sm mt-tagq" placeholder={t('Filter tags')} aria-label={t('Filter tags')}
              value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
            <span className="segmented" role="group" aria-label={t('Sort tags')}>
              <button type="button" className="segmented__option" aria-pressed={sort === 'use'} onClick={() => setSort('use')}>{t('By use')}</button>
              <button type="button" className="segmented__option" aria-pressed={sort === 'az'} onClick={() => setSort('az')}>{t('A to Z')}</button>
            </span>
          </div>
          <div className="mt-list" role="list">
            {shown.map(row)}
            {shown.length === 0 && <p className="mt-empty">{t('No tag matches “{query}”.', { query: query.trim() })}</p>}
          </div>
        </>
      )}
    </>
  );
}

export default function Manage({ isActive, onShowCards }) {
  const { t, tp, formatNumber } = useT();
  const { can } = useSession();
  const m = useManage(isActive);
  const [tab, setTab] = useState('categories');

  return (
    <div className="mt-view">
      <article className="mt-report">
        <div className="mt-eyebrow">{t('Categories and tags')}</div>
        <h1 className="mt-title">{t('Metadata')}</h1>
        {m.firstLoad && !m.error ? (
          <LoadingState message={t('Loading categories and tags…')} />
        ) : m.firstLoad ? (
          <ErrorState error={m.error} onRetry={m.reload} />
        ) : (
          <>
            <p className="mt-lede">
              {t('{categories} and {tags} classify the {cards} in this vault.', {
                categories: tp('{n} category', '{n} categories', m.categories.length, { n: formatNumber(m.categories.length) }),
                tags: tp('{n} tag', '{n} tags', m.tags.length, { n: formatNumber(m.tags.length) }),
                cards: tp('{n} card', '{n} cards', m.totalCards, { n: formatNumber(m.totalCards) }),
              })}
            </p>
            <div className="tabs mt-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'categories'} onClick={() => setTab('categories')}>
                {t('Categories')} <span>{formatNumber(m.categories.length)}</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === 'tags'} onClick={() => setTab('tags')}>
                {t('Tags')} <span>{formatNumber(m.tags.length)}</span>
              </button>
            </div>
            {m.actionError && <p className="mt-error" role="alert">{m.actionError}</p>}
            <section role="tabpanel" aria-label={tab === 'categories' ? t('Categories') : t('Tags')}>
              {tab === 'categories'
                ? <Categories m={m} mayEdit={can('manageCategories')} onShowCards={onShowCards} />
                : <Tags m={m} mayEdit={can('manageTags')} onShowCards={onShowCards} />}
            </section>
          </>
        )}
      </article>
    </div>
  );
}
