import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { listDocumentMedia, documentMediaSrc } from '../../api/reader';
import { useT } from '../../translations';
import './BookImagePicker.css';
import './ClipMediaPicker.css';

// Browse the pictures and sound a saved web clip carries, and pick one for a
// flashcard. A sibling of BookImagePicker rather than a mode of it: a sound cannot be
// shown as a thumbnail, so the two need genuinely different item chrome, and the book
// picker is shipped code worth leaving alone. The shell — backdrop, panel, header,
// Escape — is the same, and comes from the same stylesheet.
//
// Most of what it lists is not in the vault: clipping downloads no media, so an asset
// still lives on the site it came from until someone puts it on a card. The picker
// treats both the same and loads a remote thumbnail straight from that site, which is
// what the article itself is already doing a few pixels away. `cached` therefore only
// decides where the preview is fetched from, never whether an entry can be chosen.
//
// Deliberately a chooser and nothing else: it hands back the chosen entry, and the
// caller both saves it into the vault and turns it into a File (FlashcardForm's
// fetchSourceFile).
//
// `kind` is which card slot opened it — an image slot has no use for an audio file
// and vice versa — so the picker only ever offers what the slot can hold.

export default function ClipMediaPicker({ clipPath, kind = 'image', onPick, onClose }) {
  const { t } = useT();
  const [media, setMedia] = useState(null);
  const [error, setError] = useState(null);
  const [heading, setHeading] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setMedia(null);
    setError(null);
    listDocumentMedia(clipPath)
      .then((data) => { if (!cancelled) setMedia(data.media ?? []); })
      .catch((err) => { if (!cancelled) setError(err.message ?? t('Could not read this clip\'s media')); });
    return () => { cancelled = true; };
  }, [clipPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A `data:` asset is written into the clip body itself. It shows on the page but
  // has no address to save it from, so it is left out rather than offered and refused.
  const ofKind = useMemo(
    () => (media ?? []).filter((m) => m.kind === kind && !/^data:/i.test(m.href ?? '')),
    [media, kind],
  );

  // Section headings in document order. An asset above the article's first heading
  // has none, and lives under "All".
  const headings = useMemo(() => {
    const seen = [];
    for (const m of ofKind) {
      if (m.heading && !seen.includes(m.heading)) seen.push(m.heading);
    }
    return seen;
  }, [ofKind]);

  const shown = useMemo(
    () => (heading === 'all' ? ofKind : ofKind.filter((m) => m.heading === heading)),
    [ofKind, heading],
  );

  const title = kind === 'audio' ? t('Sound in this clip') : t('Images in this clip');

  const body = () => {
    if (error) return <p className="bip-note bip-note--error">{error}</p>;
    if (media === null) return <p className="bip-note">{t('Reading the clip…')}</p>;
    if (ofKind.length === 0) {
      return (
        <p className="bip-note">
          {kind === 'audio' ? t('This clip has no sound.') : t('This clip has no images.')}
        </p>
      );
    }

    return (
      <ul className={kind === 'audio' ? 'cmp-list' : 'bip-grid'}>
        {shown.map((m) => (
          <li key={`${m.index}-${m.href}`}>
            {kind === 'audio' ? <AudioRow m={m} clipPath={clipPath} onPick={onPick} t={t} />
                              : <ImageTile m={m} clipPath={clipPath} onPick={onPick} t={t} />}
          </li>
        ))}
      </ul>
    );
  };

  return createPortal(
    <div className="bip-backdrop" onClick={onClose} aria-hidden="true">
      <div
        className="bip-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bip-header">
          <h3 className="bip-title">{title}</h3>
          {headings.length > 1 && (
            <select
              className="bip-filter"
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
              aria-label={t('Filter by section')}
            >
              <option value="all">{t('All sections')}</option>
              {headings.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          )}
          <button type="button" className="bip-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </header>
        <div className="bip-body">{body()}</div>
      </div>
    </div>,
    document.body,
  );
}

// Where to load an asset's preview from: the vault if it has been saved there, the
// original site if it has not. Either way the user sees the actual picture, which is
// the only thing a picker owes them.
function previewSrc(m, clipPath) {
  return m.cached ? documentMediaSrc(clipPath, m.href) : m.href;
}

// Said only of an asset still on the web, and said quietly: it is not a warning but
// the answer to "what happens if I use this one".
function remoteNote(m, t) {
  return m.cached ? null : t('Saved to the vault when you use it');
}

function ImageTile({ m, clipPath, onPick, t }) {
  return (
    <button type="button" className="bip-item" onClick={() => onPick(m)} title={m.href}>
      <span className="bip-thumb">
        <img src={previewSrc(m, clipPath)} alt={m.alt ?? ''} loading="lazy" />
      </span>
      <span className="bip-meta">
        {/* Whatever names this picture best: its caption, else its alt text, else the
            file name — one of the three is always there. */}
        <span className="bip-label">{m.caption || m.alt || m.name}</span>
        <span className="bip-sub">{m.heading || t('Not in a section')}</span>
        {!m.cached && <span className="bip-sub cmp-sub--remote">{remoteNote(m, t)}</span>}
      </span>
    </button>
  );
}

function AudioRow({ m, clipPath, onPick, t }) {
  return (
    <div className="cmp-row" title={m.href}>
      <span className="bip-meta cmp-row-meta">
        <span className="bip-label">{m.caption || m.alt || m.name}</span>
        <span className="bip-sub">{m.heading || t('Not in a section')}</span>
        {!m.cached && <span className="bip-sub cmp-sub--remote">{remoteNote(m, t)}</span>}
      </span>
      {/* Listening before choosing is the whole point — a sound's file name says even
          less about it than a figure's does. */}
      <audio className="cmp-audio" src={previewSrc(m, clipPath)} controls preload="none" />
      <button type="button" className="cmp-use" onClick={() => onPick(m)}>{t('Use')}</button>
    </div>
  );
}
