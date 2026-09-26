/**
 * ClipMediaPicker — a clip's pictures or sounds, by the heading they sit under,
 * for putting one on a card. An asset still on the web is shown from its own
 * host and saved into the vault only when it is used; the note under it says so.
 */

import { useEffect, useMemo, useState } from 'react';
import { listDocumentMedia, documentMediaSrc } from '../../api/reader';
import { useT } from '../../translations/index';
import { PickerShell, PickerNote, ImageTile, SectionFilter } from './MediaPickerParts';
import './ClipMediaPicker.css';

/** The vault copy when there is one, the original site otherwise. */
const previewSrc = (m, clipPath) => (m.cached ? documentMediaSrc(clipPath, m.href) : m.href);

function AudioRow({ m, clipPath, onPick }) {
  const { t } = useT();
  return (
    <div className="cmp-row" title={m.href}>
      <span className="bip-meta cmp-row-meta">
        <span className="bip-label">{m.caption || m.alt || m.name}</span>
        <span className="bip-sub">{m.heading || t('Not in a section')}</span>
        {!m.cached && <span className="bip-sub cmp-sub--remote">{t('Saved to the vault when you use it')}</span>}
      </span>
      <audio className="cmp-audio" src={previewSrc(m, clipPath)} controls preload="none" />
      <button type="button" className="btn btn--quiet-accent btn--sm" onClick={() => onPick(m)}>{t('Use')}</button>
    </div>
  );
}

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipPath]);

  const ofKind = useMemo(() => (media ?? []).filter((m) => m.kind === kind && !/^data:/i.test(m.href ?? '')), [media, kind]);
  const headings = useMemo(() => {
    const seen = [];
    for (const m of ofKind) if (m.heading && !seen.includes(m.heading)) seen.push(m.heading);
    return seen.map((h) => ({ value: h, label: h }));
  }, [ofKind]);
  const shown = useMemo(() => (heading === 'all' ? ofKind : ofKind.filter((m) => m.heading === heading)), [ofKind, heading]);

  const title = kind === 'audio' ? t('Sound in this clip') : t('Images in this clip');
  const filter = headings.length > 1 && (
    <SectionFilter value={heading} options={headings} onChange={setHeading} label={t('Filter by section')} allLabel={t('All sections')} />
  );

  return (
    <PickerShell title={title} filter={filter} onClose={onClose}>
      {error && <PickerNote error>{error}</PickerNote>}
      {!error && media === null && <PickerNote>{t('Reading the clip…')}</PickerNote>}
      {!error && media !== null && ofKind.length === 0 && (
        <PickerNote>{kind === 'audio' ? t('This clip has no sound.') : t('This clip has no images.')}</PickerNote>
      )}
      {!error && ofKind.length > 0 && (
        <ul className={kind === 'audio' ? 'cmp-list' : 'bip-grid'}>
          {shown.map((m) => (
            <li key={`${m.index}-${m.href}`}>
              {kind === 'audio'
                ? <AudioRow m={m} clipPath={clipPath} onPick={onPick} />
                : <ImageTile
                    src={previewSrc(m, clipPath)}
                    alt={m.alt}
                    label={m.caption || m.alt || m.name}
                    sub={m.heading || t('Not in a section')}
                    note={m.cached ? null : t('Saved to the vault when you use it')}
                    title={m.href}
                    onPick={() => onPick(m)}
                  />}
            </li>
          ))}
        </ul>
      )}
    </PickerShell>
  );
}
