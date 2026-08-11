import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { listBookImages, bookImageSrc } from '../../api/reader';
import { useT } from '../../translations';
import './BookImagePicker.css';

// Browse the figures inside an EPUB and pick one for a flashcard. The list is
// metadata (/api/reader/images); each thumbnail streams its own bytes through
// /api/reader/image, so opening the picker on a heavily illustrated book costs one
// small JSON response plus whatever the browser decides to render.
//
// Deliberately a chooser and nothing else: it hands back the chosen entry and the
// caller turns it into a File (api/reader.fetchBookImageFile). That keeps it usable
// from anywhere a picture is wanted, not just the card form it was written for.

export default function BookImagePicker({ bookPath, onPick, onClose }) {
  const { t } = useT();
  const [images, setImages] = useState(null);
  const [error, setError] = useState(null);
  const [section, setSection] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setImages(null);
    setError(null);
    listBookImages(bookPath)
      .then((data) => { if (!cancelled) setImages(data.images ?? []); })
      .catch((err) => { if (!cancelled) setError(err.message ?? t('Could not read this book\'s images')); });
    return () => { cancelled = true; };
  }, [bookPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Section names in reading order, skipping the pages with no prose — an image on a
  // plate page has no section number to filter by, so it lives under "All".
  const sections = useMemo(() => {
    const seen = new Map();
    for (const img of images ?? []) {
      if (img.sectionIndex != null && !seen.has(img.sectionIndex)) {
        seen.set(img.sectionIndex, img.section);
      }
    }
    return [...seen.entries()].map(([index, label]) => ({ index, label }));
  }, [images]);

  const shown = useMemo(() => {
    if (!images) return [];
    return section === 'all' ? images : images.filter((i) => i.sectionIndex === section);
  }, [images, section]);

  const body = () => {
    if (error) return <p className="bip-note bip-note--error">{error}</p>;
    if (images === null) return <p className="bip-note">{t('Reading the book…')}</p>;
    if (images.length === 0) return <p className="bip-note">{t('This book has no images.')}</p>;

    return (
      <ul className="bip-grid">
        {shown.map((img) => (
          <li key={img.href}>
            <button
              type="button"
              className="bip-item"
              onClick={() => onPick(img)}
              title={img.href}
            >
              <span className="bip-thumb">
                <img src={bookImageSrc(bookPath, img.href)} alt={img.alt ?? ''} loading="lazy" />
              </span>
              <span className="bip-meta">
                {/* Whatever names this figure best: its caption, else its alt text,
                    else the file name — one of the three is always there. */}
                <span className="bip-label">{img.caption || img.alt || img.name}</span>
                <span className="bip-sub">
                  {img.isCover ? t('Cover') : (img.section || t('Not in a chapter'))}
                </span>
              </span>
            </button>
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
        aria-label={t('Images in this book')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bip-header">
          <h3 className="bip-title">{t('Images in this book')}</h3>
          {sections.length > 1 && (
            <select
              className="bip-filter"
              value={section}
              onChange={(e) => setSection(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              aria-label={t('Filter by chapter')}
            >
              <option value="all">{t('All chapters')}</option>
              {sections.map((s) => (
                <option key={s.index} value={s.index}>{s.label}</option>
              ))}
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
