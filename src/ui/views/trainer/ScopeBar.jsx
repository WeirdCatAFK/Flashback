/**
 * ScopeBar — the chips that say what a session covers and the pickers that
 * change it: folder, document, deck, tags, and the "leave out" row behind the
 * Exclude button. Pickers are lists inside a Popover; the tag filter is the
 * shared TagChipInput.
 */

import { useState, useEffect, useRef } from 'react';
import { getTags, listFolder } from '../../api/documents';
import { listDecks } from '../../api/decks';
import Popover from '../../components/base/Popover';
import TagChipInput from '../../components/base/TagChipInput';
import { useT } from '../../translations/index';

const EMPTY_TAGS = [];

/** A chip naming one part of the scope, with its clear button. */
function ScopeChip({ children, exclude = false, onClear }) {
  const { t } = useT();
  return (
    <span className={`chip${exclude ? ' chip--danger' : ''}`}>
      {children}
      <button type="button" className="chip__remove" onClick={onClear} title={t('Clear')} aria-label={t('Clear')}>×</button>
    </span>
  );
}

/** A picker button and the popover it opens; `load` runs each time it opens. */
function PickerButton({ label, load, children }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const toggle = () => {
    if (!open) load?.();
    setOpen((v) => !v);
  };
  return (
    <>
      <button ref={btnRef} type="button" className="btn btn--sm" onClick={toggle} aria-expanded={open}>{label}</button>
      <Popover anchorRef={btnRef} open={open} onClose={() => setOpen(false)} className="scope-picker">
        {children(() => setOpen(false))}
      </Popover>
    </>
  );
}

/**
 * Browsable path picker. Folders are always listed because you walk through them
 * to reach a document; `kind` decides what is pickable. `applyLabel` is passed in
 * so the exclude row can open the same picker to say "everything except this".
 */
function PathPicker({ kind = 'folder', label, applyLabel, onPick }) {
  const { t } = useT();
  const [browsePath, setBrowsePath] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadLevel = (folderPath) => {
    setLoading(true);
    setBrowsePath(folderPath);
    listFolder(folderPath)
      .then((list) => setItems(kind === 'document' ? list : list.filter((i) => i.type === 'folder')))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  const crumbs = browsePath ? browsePath.split('/') : [];

  return (
    <PickerButton label={label} load={() => loadLevel('')}>
      {(close) => (
        <>
          <div className="scope-picker-breadcrumb">
            <button type="button" className="scope-picker-crumb" onClick={() => loadLevel('')}>{t('root')}</button>
            {crumbs.map((seg, i) => {
              const segPath = crumbs.slice(0, i + 1).join('/');
              return (
                <span key={segPath}>
                  <span className="scope-picker-sep"> / </span>
                  <button type="button" className="scope-picker-crumb" onClick={() => loadLevel(segPath)}>{seg}</button>
                </span>
              );
            })}
          </div>
          {browsePath && kind === 'folder' && (
            <button type="button" className="btn btn--primary btn--sm btn--block" onClick={() => { onPick(browsePath); close(); }}>
              {applyLabel(crumbs.at(-1))}
            </button>
          )}
          {loading && <span className="popover__empty">{t('Loading…')}</span>}
          {!loading && items.length === 0 && (
            <span className="popover__empty">{kind === 'document' ? t('Nothing here') : t('No subfolders')}</span>
          )}
          {!loading && items.map((item) => {
            const itemPath = browsePath ? `${browsePath}/${item.name}` : item.name;
            const pickable = kind === 'folder' || item.type !== 'folder';
            return (
              <div key={itemPath} className="scope-picker-item">
                <button type="button" className="popover__item" disabled={!pickable} onClick={() => { onPick(itemPath); close(); }}>
                  {item.name}
                </button>
                {item.type === 'folder' && (
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => loadLevel(itemPath)} title={t('Show subfolders')}>›</button>
                )}
              </div>
            );
          })}
        </>
      )}
    </PickerButton>
  );
}

/** Flat deck list picker. */
function DeckPicker({ label, onPick }) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    listDecks()
      .then((data) => setDecks(Array.isArray(data) ? data : []))
      .catch(() => setDecks([]))
      .finally(() => setLoading(false));
  };
  return (
    <PickerButton label={label} load={load}>
      {(close) => (
        <>
          {loading && <span className="popover__empty">{t('Loading…')}</span>}
          {!loading && decks.length === 0 && <span className="popover__empty">{t('No decks yet')}</span>}
          {!loading && decks.map((deck) => (
            <button type="button" key={deck.global_hash} className="popover__item"
              onClick={() => { onPick({ deck: deck.global_hash, deckName: deck.name }); close(); }}>
              {deck.name}
            </button>
          ))}
        </>
      )}
    </PickerButton>
  );
}

/** Flat tag list picker — exclusions are chosen once, so they take the dropdown shape. */
function TagPicker({ label, chosen = EMPTY_TAGS, onPick }) {
  const { t } = useT();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    getTags()
      .then((d) => setTags(d.tags ?? []))
      .catch(() => setTags([]))
      .finally(() => setLoading(false));
  };
  const available = tags.filter((tag) => !chosen.includes(tag));
  return (
    <PickerButton label={label} load={load}>
      {(close) => (
        <>
          {loading && <span className="popover__empty">{t('Loading…')}</span>}
          {!loading && available.length === 0 && <span className="popover__empty">{t('No tags yet')}</span>}
          {!loading && available.map((tag) => (
            <button type="button" key={tag} className="popover__item" onClick={() => { onPick(tag); close(); }}>{tag}</button>
          ))}
        </>
      )}
    </PickerButton>
  );
}

/** The positive tag filter: a chip input over every tag in the vault. */
function TagFilter({ selected = EMPTY_TAGS, onApply }) {
  const { t } = useT();
  const [allTags, setAllTags] = useState([]);
  useEffect(() => {
    getTags().then((d) => setAllTags(d.tags ?? [])).catch(console.error);
  }, []);
  return (
    <div className="trainer-tag-filter">
      <TagChipInput
        tags={selected}
        allKnownTags={allTags}
        placeholder={t('Filter by tag…')}
        ariaLabel={t('Filter by tag')}
        onAdd={(tag) => onApply([...selected, tag])}
        onRemove={(tag) => {
          const next = selected.filter((x) => x !== tag);
          onApply(next.length > 0 ? next : null);
        }}
      />
    </div>
  );
}

export default function ScopeBar({ controls }) {
  const { t } = useT();
  const { scope, showExclude } = controls;

  return (
    <>
      <div className="trainer-scope-bar">
        {scope.deck && <ScopeChip onClear={controls.clearDeck}>{t('Deck: {name}', { name: scope.deckName ?? scope.deck })}</ScopeChip>}
        {scope.folder && <ScopeChip onClear={controls.clearFolder}>{t('Folder: {path}', { path: scope.folder })}</ScopeChip>}
        {scope.document && <ScopeChip onClear={controls.clearDocument}>{t('Document: {path}', { path: scope.document })}</ScopeChip>}
        {scope.exclude.folders.map((path) => (
          <ScopeChip key={`xf:${path}`} exclude onClear={() => controls.removeExclusion('folders', path)}>{t('Except folder: {path}', { path })}</ScopeChip>
        ))}
        {scope.exclude.documents.map((path) => (
          <ScopeChip key={`xd:${path}`} exclude onClear={() => controls.removeExclusion('documents', path)}>{t('Except document: {path}', { path })}</ScopeChip>
        ))}
        {scope.exclude.decks.map((deck) => (
          <ScopeChip key={`xk:${deck.hash}`} exclude onClear={() => controls.removeExclusion('decks', deck.hash)}>{t('Except deck: {name}', { name: deck.name ?? deck.hash })}</ScopeChip>
        ))}
        {scope.exclude.tags.map((tag) => (
          <ScopeChip key={`xt:${tag}`} exclude onClear={() => controls.removeExclusion('tags', tag)}>{t('Except tag: {name}', { name: tag })}</ScopeChip>
        ))}

        {!scope.folder && (
          <PathPicker kind="folder" label={t('+ Folder')} onPick={controls.applyFolder} applyLabel={(name) => t('Study “{name}”', { name })} />
        )}
        {!scope.document && (
          <PathPicker kind="document" label={t('+ Document')} onPick={controls.applyDocument} applyLabel={() => null} />
        )}
        {!scope.deck && <DeckPicker label={t('+ Deck')} onPick={controls.applyDeck} />}
        <button
          type="button"
          className={`btn btn--sm${showExclude ? ' btn--accent-quiet' : ''}`}
          aria-expanded={showExclude}
          onClick={controls.toggleExclude}
        >
          {t('− Exclude')}
        </button>
        <TagFilter selected={scope.tags ?? EMPTY_TAGS} onApply={controls.applyTags} />
      </div>

      {showExclude && (
        <div className="trainer-scope-bar trainer-scope-bar--exclude">
          <span className="eyebrow">{t('Leave out')}</span>
          <PathPicker kind="folder" label={t('− Folder')}
            onPick={(path) => controls.addExclusion('folders', path)}
            applyLabel={(name) => t('Leave out “{name}”', { name })} />
          <PathPicker kind="document" label={t('− Document')}
            onPick={(path) => controls.addExclusion('documents', path)} applyLabel={() => null} />
          <DeckPicker label={t('− Deck')}
            onPick={({ deck, deckName }) => controls.addExclusion('decks', { hash: deck, name: deckName })} />
          <TagPicker label={t('− Tag')} chosen={scope.exclude.tags} onPick={(tag) => controls.addExclusion('tags', tag)} />
        </div>
      )}
    </>
  );
}
