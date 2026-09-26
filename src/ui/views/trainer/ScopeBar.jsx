/**
 * ScopeBar — what a session covers, folded into one quiet button in the Trainer's
 * top bar. The button sums the scope up in a line ("Memory · 2 left out") with a
 * count of the rules applied; it opens a panel shaped like a form: Study, one
 * labelled row per kind (folder, document, deck, tags) showing the choice or
 * "Any", then Leave out, the same rows with their picks as pills, and a foot with
 * the card count and Clear filters. Each row's control opens the same browsable
 * picker the app always had (a list inside a Popover); tags use TagChipInput.
 *
 * The panel is not itself a Popover: its pickers open Popovers of their own, and a
 * Popover dismisses on any outside click — including a click inside a nested one.
 * The panel dismisses on outside mousedown too, but ignores clicks in `.popover`.
 */

import { useState, useEffect, useRef } from 'react';
import { scopeRuleCount, scopeSummary } from './scope';
import { getTags, listFolder } from '../../api/documents';
import { listDecks } from '../../api/decks';
import Popover from '../../components/base/Popover';
import TagChipInput from '../../components/base/TagChipInput';
import { useT } from '../../translations/index';

const EMPTY_TAGS = [];

/** A picker button and the popover it opens; `load` runs each time it opens. */
function PickerButton({ label, load, children, className = 'btn btn--sm' }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const toggle = () => {
    if (!open) load?.();
    setOpen((v) => !v);
  };
  return (
    <>
      <button ref={btnRef} type="button" className={className} onClick={toggle} aria-expanded={open}>{label}</button>
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
function PathPicker({ kind = 'folder', label, applyLabel, onPick, className }) {
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
    <PickerButton label={label} load={() => loadLevel('')} className={className}>
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
function DeckPicker({ label, onPick, className }) {
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
    <PickerButton label={label} load={load} className={className}>
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
function TagPicker({ label, chosen = EMPTY_TAGS, onPick, className }) {
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
    <PickerButton label={label} load={load} className={className}>
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

const leaf = (path) => path.split(/[\\/]/).pop();
const SELECT = 'scope-select';

/** One labelled line of the panel: the label on the left, the control on the right. */
function Row({ label, children }) {
  return (
    <div className="scope-row">
      <span className="scope-row-label">{label}</span>
      <div className="scope-row-control">{children}</div>
    </div>
  );
}

/** A chosen value that can be cleared: the picker still opens from its name. */
function Chosen({ children, onClear }) {
  const { t } = useT();
  return (
    <span className="scope-chosen">
      {children}
      <button type="button" className="scope-chosen-clear" onClick={onClear} title={t('Clear')} aria-label={t('Clear')}>×</button>
    </span>
  );
}

/** A left-out value, as a pill under its row. */
function Pill({ children, onRemove }) {
  const { t } = useT();
  return (
    <span className="scope-pill">
      {children}
      <button type="button" onClick={onRemove} title={t('Put it back')} aria-label={t('Put it back')}>×</button>
    </span>
  );
}

/** What is in: one row per kind, each showing the choice or "Any". */
function StudySection({ controls }) {
  const { t } = useT();
  const { scope } = controls;
  return (
    <div className="scope-panel-section">
      <div className="eyebrow scope-panel-heading">{t('Study')}</div>
      <Row label={t('Folder')}>
        {scope.folder
          ? <Chosen onClear={controls.clearFolder}><span title={scope.folder}>{leaf(scope.folder)}</span></Chosen>
          : <PathPicker kind="folder" className={SELECT} label={t('Any folder')} onPick={controls.applyFolder} applyLabel={(name) => t('Study “{name}”', { name })} />}
      </Row>
      <Row label={t('Document')}>
        {scope.document
          ? <Chosen onClear={controls.clearDocument}><span title={scope.document}>{leaf(scope.document)}</span></Chosen>
          : <PathPicker kind="document" className={SELECT} label={t('Any document')} onPick={controls.applyDocument} applyLabel={() => null} />}
      </Row>
      <Row label={t('Deck')}>
        {scope.deck
          ? <Chosen onClear={controls.clearDeck}>{scope.deckName ?? scope.deck}</Chosen>
          : <DeckPicker className={SELECT} label={t('Any deck')} onPick={controls.applyDeck} />}
      </Row>
      <Row label={t('Tags')}>
        <TagFilter selected={scope.tags ?? EMPTY_TAGS} onApply={controls.applyTags} />
      </Row>
    </div>
  );
}

/** What is out: one row per kind, its picks as pills, and a picker to add one more. */
function LeaveOutSection({ controls }) {
  const { t } = useT();
  const { exclude } = controls.scope;
  return (
    <div className="scope-panel-section">
      <div className="eyebrow scope-panel-heading">{t('Leave out')}</div>
      <Row label={t('Folders')}>
        <PathPicker kind="folder" className={SELECT} label={t('Add a folder')}
          onPick={(path) => controls.addExclusion('folders', path)}
          applyLabel={(name) => t('Leave out “{name}”', { name })} />
        {exclude.folders.map((path) => (
          <Pill key={path} onRemove={() => controls.removeExclusion('folders', path)}><span title={path}>{leaf(path)}</span></Pill>
        ))}
      </Row>
      <Row label={t('Documents')}>
        <PathPicker kind="document" className={SELECT} label={t('Add a document')}
          onPick={(path) => controls.addExclusion('documents', path)} applyLabel={() => null} />
        {exclude.documents.map((path) => (
          <Pill key={path} onRemove={() => controls.removeExclusion('documents', path)}><span title={path}>{leaf(path)}</span></Pill>
        ))}
      </Row>
      <Row label={t('Decks')}>
        <DeckPicker className={SELECT} label={t('Add a deck')}
          onPick={({ deck, deckName }) => controls.addExclusion('decks', { hash: deck, name: deckName })} />
        {exclude.decks.map((deck) => (
          <Pill key={deck.hash} onRemove={() => controls.removeExclusion('decks', deck.hash)}>{deck.name ?? deck.hash}</Pill>
        ))}
      </Row>
      <Row label={t('Tags')}>
        <TagPicker className={SELECT} label={t('Add a tag')} chosen={exclude.tags} onPick={(tag) => controls.addExclusion('tags', tag)} />
        {exclude.tags.map((tag) => (
          <Pill key={tag} onRemove={() => controls.removeExclusion('tags', tag)}>#{tag}</Pill>
        ))}
      </Row>
    </div>
  );
}

export default function ScopeBar({ controls, result }) {
  const { t, tp } = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const summary = scopeSummary(controls.scope, t, tp);
  const rules = scopeRuleCount(controls.scope);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target) || e.target.closest?.('.popover')) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.popover')) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="scope-filter" ref={wrapRef}>
      <button type="button" className="scope-filter-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="18" x2="14" y2="18" />
        </svg>
        <span className="scope-filter-summary">
          {summary.study}
          {summary.leftOut && <span className="scope-filter-muted"> · {summary.leftOut}</span>}
        </span>
        {rules > 0 && <span className="scope-filter-count">{rules}</span>}
      </button>
      {open && (
        <div className="scope-panel" role="dialog" aria-label={t('What to study')}>
          <StudySection controls={controls} />
          <LeaveOutSection controls={controls} />
          <div className="scope-panel-foot">
            <span className="scope-panel-result">
              {result
                ? <><b>{tp('{n} card', '{n} cards', result.counts.due + result.counts.new)}</b> {t('{due} due · {new} new', { due: result.counts.due, new: result.counts.new })}</>
                : '—'}
            </span>
            <button type="button" className="link-action" onClick={controls.clearScope} disabled={rules === 0}>{t('Clear filters')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
