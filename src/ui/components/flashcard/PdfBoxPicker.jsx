/**
 * PdfBoxPicker — the box highlights drawn on a PDF, by page, for putting one on a
 * card: the PDF counterpart of a book's figures or a clip's images. A box has no
 * file behind it, so each tile is its region rendered from the page (pdfjs.js),
 * and picking one hands over that rendering as the File. It opens the PDF itself
 * rather than borrowing the viewer's, and is loaded lazily so pdf.js stays out of
 * the card editor until a PDF's card asks for it.
 */

import { useEffect, useMemo, useState } from 'react';
import { readFile, rawDocumentUrl } from '../../api/documents';
import { getDocument, renderRegion, isBoxHighlight } from '../document/renderers/pdf/pdfjs.js';
import { useT } from '../../translations/index';
import { PickerShell, PickerNote, ImageTile, SectionFilter } from './MediaPickerParts';

export default function PdfBoxPicker({ pdfPath, onPick, onClose }) {
  const { t } = useT();
  const [boxes, setBoxes] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState('all');

  useEffect(() => {
    let cancelled = false;
    const urls = [];
    const task = getDocument({ url: rawDocumentUrl(pdfPath) });
    setBoxes(null);
    setError(null);
    (async () => {
      const [doc, data] = await Promise.all([task.promise, readFile(pdfPath)]);
      const found = (data.metadata?.highlights ?? []).filter(isBoxHighlight)
        .sort((a, b) => a.page - b.page || a.bbox.y - b.bbox.y);
      const rendered = [];
      for (const h of found) {
        if (cancelled) return;
        const file = await renderRegion(await doc.getPage(h.page), h.bbox, `page-${h.page}-${h.id}.png`).catch(() => null);
        if (!file) continue;
        const src = URL.createObjectURL(file);
        urls.push(src);
        rendered.push({ id: h.id, page: h.page, file, src });
      }
      if (!cancelled) setBoxes(rendered);
    })().catch((err) => { if (!cancelled) setError(err.message ?? t('Could not read this PDF\'s boxes')); });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
      task.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPath]);

  const pages = useMemo(
    () => [...new Set((boxes ?? []).map((b) => b.page))].map((p) => ({ value: String(p), label: t('Page {n}', { n: p }) })),
    [boxes, t],
  );
  const shown = useMemo(() => (page === 'all' ? boxes ?? [] : (boxes ?? []).filter((b) => String(b.page) === page)), [boxes, page]);

  const filter = pages.length > 1 && (
    <SectionFilter value={page} options={pages} onChange={setPage} label={t('Filter by page')} allLabel={t('All pages')} />
  );

  return (
    <PickerShell title={t('Boxes in this PDF')} filter={filter} onClose={onClose}>
      {error && <PickerNote error>{error}</PickerNote>}
      {!error && boxes === null && <PickerNote>{t('Reading the PDF…')}</PickerNote>}
      {!error && boxes?.length === 0 && <PickerNote>{t('This PDF has no box highlights. Draw one with Box highlight.')}</PickerNote>}
      {!error && boxes?.length > 0 && (
        <ul className="bip-grid">
          {shown.map((b) => (
            <li key={b.id}>
              <ImageTile src={b.src} label={t('Page {n}', { n: b.page })} onPick={() => onPick({ file: b.file })} />
            </li>
          ))}
        </ul>
      )}
    </PickerShell>
  );
}
