/**
 * The pieces the two media pickers share: the dialog shell with its filter
 * select, the note line for loading / empty / error, and one image tile.
 */

import Modal from '../base/Modal';
import { useT } from '../../translations/index';
import './BookImagePicker.css';

/** The picker dialog: a title, an optional filter, and the grid or note inside. */
export function PickerShell({ title, filter, onClose, children }) {
  return (
    <Modal title={title} size="lg" onClose={onClose} className="bip-panel">
      {filter && <div className="bip-filter-row">{filter}</div>}
      <div className="bip-body">{children}</div>
    </Modal>
  );
}

export function PickerNote({ error, children }) {
  return <p className={`bip-note${error ? ' bip-note--error' : ''}`}>{children}</p>;
}

/** One picture: its preview, caption and where it sits. */
export function ImageTile({ src, alt, label, sub, note, onPick, title }) {
  return (
    <button type="button" className="bip-item" onClick={onPick} title={title}>
      <span className="bip-thumb"><img src={src} alt={alt ?? ''} loading="lazy" /></span>
      <span className="bip-meta">
        <span className="bip-label">{label}</span>
        <span className="bip-sub">{sub}</span>
        {note && <span className="bip-sub cmp-sub--remote">{note}</span>}
      </span>
    </button>
  );
}

/** A select over the sections an asset list spans. */
export function SectionFilter({ value, options, onChange, label, allLabel }) {
  const { t } = useT();
  return (
    <select className="field field--sm bip-filter" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label ?? t('Filter by section')}>
      <option value="all">{allLabel}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
