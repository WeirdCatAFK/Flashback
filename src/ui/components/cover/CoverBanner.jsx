/**
 * CoverBanner — the banner at the head of a deck's page or a document: an image of
 * your own, or a pattern drawn in the owner's colour. Someone who may edit gets
 * "Add cover" when there is none, and on hover Change cover (the drawn ones, or
 * upload an image), Reposition (an image only: drag it, then Save position) and
 * Remove. `source` is how this owner's cover is reached — `{ imageUrl(file),
 * upload(file), set(change), remove() }`, each resolving `{ cover }` like the API
 * — and `onChange(cover)` hands back what the server stored, null when removed.
 *
 *   <CoverBanner cover={deck.cover} tint="var(--color-box-sage)" source={deckSource} editable onChange={setCover} />
 */

import { useRef, useState } from 'react';
import Popover from '../base/Popover';
import { useT } from '../../translations/index';
import { coverTravel, dragCoverY } from './coverMath.js';
import { COVER_PATTERNS } from '../../../shared/covers.js';
import './CoverBanner.css';

/** A drawn cover. Pure geometry; its colour comes from --sleeve. */
export function CoverArt({ pattern }) {
  if (pattern === 'arcs') {
    return (
      <svg viewBox="0 0 620 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g className="cover-banner__line">
          {Array.from({ length: 9 }, (_, k) => (
            <circle key={k} cx="540" cy="170" r={40 + k * 26} fill="none" strokeWidth="10" opacity={0.18 + k * 0.07} />
          ))}
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 620 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g className="cover-banner__shape">
        {Array.from({ length: 18 }, (_, k) => {
          const x = 20 + (k % 9) * 66;
          const y = 18 + Math.floor(k / 9) * 64;
          const r = ((k * 37) % 9) - 4;
          return <rect key={k} x={x} y={y} width="48" height="30" rx="3" transform={`rotate(${r} ${x + 24} ${y + 15})`} opacity={0.35 + ((k * 13) % 5) / 10} />;
        })}
      </g>
    </svg>
  );
}

function patternLabel(id, t) {
  return id === 'arcs' ? t('Rings') : t('Scattered cards');
}

export default function CoverBanner({ cover, tint = 'var(--color-kraft)', source, editable = false, addClassName = '', onChange }) {
  const { t } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [placing, setPlacing] = useState(null);
  const menuAnchor = useRef(null);
  const addAnchor = useRef(null);
  const fileRef = useRef(null);
  const frameRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);

  const sleeve = tint;
  const image = cover?.kind === 'image' ? cover : null;

  const apply = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      onChange?.(res?.cover ?? null);
      return true;
    } catch (err) {
      setError(err.message ?? String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const choosePattern = (pattern) => { setMenuOpen(false); apply(() => source.set({ pattern })); };
  const chooseFile = (file) => { if (file) apply(() => source.upload(file)); };
  const remove = () => apply(async () => { await source.remove(); return null; });
  const savePosition = async () => {
    if (await apply(() => source.set({ y: placing.y }))) setPlacing(null);
  };

  const onPointerDown = (e) => {
    if (!placing || !imgRef.current || !frameRef.current) return;
    const { naturalWidth, naturalHeight } = imgRef.current;
    const { clientWidth, clientHeight } = frameRef.current;
    dragRef.current = { startClientY: e.clientY, startY: placing.y, travel: coverTravel(naturalWidth, naturalHeight, clientWidth, clientHeight) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setPlacing({ y: dragCoverY(d.startY, e.clientY - d.startClientY, d.travel) });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const menu = (anchor) => (
    <Popover anchorRef={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} align="end" role="dialog" ariaLabel={t('Change cover')} className="cover-banner-menu">
      <div className="popover__heading">{t('Drawn')}</div>
      <div className="cover-banner-menu__patterns">
        {COVER_PATTERNS.map((p) => (
          <button
            key={p}
            type="button"
            className="cover-banner-menu__pattern"
            style={{ '--sleeve': sleeve }}
            aria-pressed={cover?.kind === 'pattern' && cover.pattern === p}
            onClick={() => choosePattern(p)}
          >
            <span className="cover-banner-menu__art"><CoverArt pattern={p} /></span>
            <span>{patternLabel(p, t)}</span>
          </button>
        ))}
      </div>
      <div className="popover__sep" />
      <button type="button" className="popover__item" onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>
        {t('Upload an image…')}
      </button>
      <p className="cover-banner-menu__hint">{t('PNG, JPEG, WebP, GIF or AVIF, up to 10 MB')}</p>
    </Popover>
  );

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
      hidden
      onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ''; }}
    />
  );

  if (!cover) {
    if (!editable) return null;
    return (
      <div className={`cover-banner-add-row${addClassName ? ` ${addClassName}` : ''}`}>
        <button ref={addAnchor} type="button" className="cover-banner-add" onClick={() => setMenuOpen((v) => !v)} disabled={busy}>
          {busy ? t('Saving…') : t('Add cover')}
        </button>
        {error && <span className="cover-banner-error" role="alert">{error}</span>}
        {menu(addAnchor)}
        {fileInput}
      </div>
    );
  }

  const y = placing ? placing.y : image?.y ?? 0.5;
  return (
    <div
      ref={frameRef}
      className={`cover-banner${placing ? ' is-placing' : ''}${busy ? ' is-busy' : ''}`}
      style={{ '--sleeve': sleeve }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => { if (e.key === 'Escape' && placing) { e.stopPropagation(); setPlacing(null); } }}
    >
      {image ? (
        <img
          ref={imgRef}
          className="cover-banner__img"
          src={source.imageUrl(image.file)}
          alt=""
          draggable={false}
          style={{ objectPosition: `50% ${Math.round(y * 1000) / 10}%` }}
        />
      ) : (
        <CoverArt pattern={cover.pattern} />
      )}

      {placing && <span className="cover-banner__hint">{t('Drag the image to reposition')}</span>}

      {editable && (
        <div className="cover-banner__actions" onPointerDown={(e) => e.stopPropagation()}>
          {placing ? (
            <>
              <button type="button" onClick={savePosition} disabled={busy}>{t('Save position')}</button>
              <button type="button" onClick={() => setPlacing(null)} disabled={busy}>{t('Cancel')}</button>
            </>
          ) : (
            <>
              <button ref={menuAnchor} type="button" onClick={() => setMenuOpen((v) => !v)} disabled={busy}>{t('Change cover')}</button>
              {image && <button type="button" onClick={() => setPlacing({ y: image.y })} disabled={busy}>{t('Reposition')}</button>}
              <button type="button" onClick={remove} disabled={busy}>{t('Remove')}</button>
            </>
          )}
        </div>
      )}
      {error && <span className="cover-banner-error cover-banner-error--over" role="alert">{error}</span>}
      {editable && menu(menuAnchor)}
      {editable && fileInput}
    </div>
  );
}
