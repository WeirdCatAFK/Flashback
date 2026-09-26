/**
 * BookImagePicker — the figures inside an EPUB, by chapter, for putting one on
 * a card. They live inside the book's zip, so the picker reads them through
 * /api/reader rather than the filesystem.
 */

import { useEffect, useMemo, useState } from 'react';
import { listBookImages, bookImageSrc } from '../../api/reader';
import { useT } from '../../translations/index';
import { PickerShell, PickerNote, ImageTile, SectionFilter } from './MediaPickerParts';

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookPath]);

  const sections = useMemo(() => {
    const seen = new Map();
    for (const img of images ?? []) {
      if (img.sectionIndex != null && !seen.has(img.sectionIndex)) seen.set(img.sectionIndex, img.section);
    }
    return [...seen.entries()].map(([index, label]) => ({ value: String(index), label }));
  }, [images]);

  const shown = useMemo(() => {
    if (!images) return [];
    return section === 'all' ? images : images.filter((i) => String(i.sectionIndex) === section);
  }, [images, section]);

  const filter = sections.length > 1 && (
    <SectionFilter value={section} options={sections} onChange={setSection} label={t('Filter by chapter')} allLabel={t('All chapters')} />
  );

  return (
    <PickerShell title={t('Images in this book')} filter={filter} onClose={onClose}>
      {error && <PickerNote error>{error}</PickerNote>}
      {!error && images === null && <PickerNote>{t('Reading the book…')}</PickerNote>}
      {!error && images?.length === 0 && <PickerNote>{t('This book has no images.')}</PickerNote>}
      {!error && images?.length > 0 && (
        <ul className="bip-grid">
          {shown.map((img) => (
            <li key={img.href}>
              <ImageTile
                src={bookImageSrc(bookPath, img.href)}
                alt={img.alt}
                label={img.caption || img.alt || img.name}
                sub={img.isCover ? t('Cover') : (img.section || t('Not in a chapter'))}
                title={img.href}
                onPick={() => onPick(img)}
              />
            </li>
          ))}
        </ul>
      )}
    </PickerShell>
  );
}
