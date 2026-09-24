/**
 * MarginCards — the document's cards in the margin, each level with its passage:
 * a tick for a highlight with no card, the card itself for one, and for several a
 * kraft box (up to four card tops peeking out, coloured by the highlight's swatch,
 * and the count) that the cards are pulled out of and put back into. Cards are
 * read-only here — clicking one turns it over, Edit opens the card editor — since
 * writing cards inside the document frame is hard in PDF and EPUB and belongs in
 * the editor. Hovering a card lights its passage, and hovering a passage lights
 * its cards.
 *
 * It finds passages by `[data-hl]` inside the scroller, which Markdown, text, clips
 * and PDF all draw; positions are measured in the scroller's content space and the
 * items are stacked imperatively (marginLayout.js) so they follow edits, zoom and
 * lazily rendered pages without re-rendering React on every scroll. The column sits
 * just right of the text — the renderer marks its column with `data-column` — so
 * text and cards stay together, centred as one, however wide the window is. It is
 * shown only when the document area is wide enough; `onShownChange` tells the
 * editor, which then makes room on the right. `outsideLinked` is a passage
 * another surface is pointing at (a Find row, a jump): it glows and its cards
 * lift as if hovered here.
 *
 * A renderer whose text is in frames (EPUB) passes `measure`, which returns the
 * same two facts — each highlight's top and the text's right edge — from inside
 * its frames, and mounts the column inside its own scrolling container.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DeckBox from '../../deck/DeckBox';
import { cardTypeShortLabel, typeAnswerParts } from '../../flashcard/flashcardFields';
import { hlColor } from '../finderRows.js';
import { marginItems, stackTops, marginFits, marginFront, marginLeft } from './marginLayout.js';
import { useT } from '../../../translations/index';
import './MarginCards.css';

/** Where passages and the text column are, read from the DOM: `[data-hl]` and `[data-column]`. */
function domMeasure(sc, box, z) {
  const anchors = new Map();
  sc.querySelectorAll('[data-hl]').forEach((el) => {
    const id = el.getAttribute('data-hl');
    if (anchors.has(id)) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    anchors.set(id, (r.top - box.top) / z + sc.scrollTop);
  });
  let right = 0;
  sc.querySelectorAll('[data-column]').forEach((el) => {
    const r = el.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(el).paddingRight) || 0;
    right = Math.max(right, (r.right - box.left) / z - pad);
  });
  return { anchors, right };
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A card's face in the margin: the front, and when turned over, what it asks for. */
function MarginCard({ card, hlId, canEdit, onEdit, cardRef, style, className = '' }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const type = card.cardType ?? (card.isCustom ? 'custom' : 'basic');
  const front = marginFront(card);
  const vd = card.vanillaData ?? {};
  const back = type === 'type_answer'
    ? [typeAnswerParts(vd).answer, typeAnswerParts(vd).notes].filter(Boolean).join(' · ')
    : type === 'cloze' || type === 'custom' ? '' : (vd.backText ?? '');

  return (
    <div
      ref={cardRef}
      style={style}
      className={`mcard${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      data-card-hl={hlId}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setOpen((o) => !o); } }}
    >
      <div className="mcard__front">
        {front.kind === 'cloze'
          ? front.parts.map((p, i) => (p.blank != null
            ? (open ? <span key={i} className="mcard__fill">{p.blank}</span> : <span key={i} className="mcard__gap" aria-label={t('blank')} />)
            : <span key={i}>{p.text}</span>))
          : (front.text || (front.kind === 'custom' ? t('Custom HTML card') : t('(empty card)')))}
      </div>
      {open && back && <div className="mcard__back">{back}</div>}
      <div className="mcard__foot">
        <span>{cardTypeShortLabel(type, t)}</span>
        {canEdit && card.globalHash && (
          <button type="button" className="mcard__edit" onClick={(e) => { e.stopPropagation(); onEdit(card.globalHash); }}>{t('Edit')}</button>
        )}
      </div>
    </div>
  );
}

/** A passage with several cards: the kraft box, and the cards when taken out. */
function MarginBox({ item, canEdit, onEdit, onToggled }) {
  const { tp } = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const cardEls = useRef([]);
  const justOpened = useRef(false);
  const edge = `color-mix(in srgb, ${hlColor(item.color)} 80%, var(--color-fg-primary) 12%)`;

  const path = (el) => {
    const dy = boxRef.current.offsetTop + 12 - el.offsetTop;
    return [
      { transform: `translateY(${dy}px) scale(0.9)`, opacity: 0, zIndex: 1 },
      { transform: `translateY(${dy - 34}px) scale(0.94)`, opacity: 1, zIndex: 1, offset: 0.3 },
      { transform: `translateY(${dy - 40}px) scale(0.95)`, opacity: 1, zIndex: 3, offset: 0.4 },
      { transform: 'none', opacity: 1, zIndex: 3 },
    ];
  };

  useLayoutEffect(() => {
    onToggled();
    if (!open || !justOpened.current || reduceMotion()) return;
    justOpened.current = false;
    cardEls.current.filter(Boolean).forEach((el, k) => {
      el.animate(path(el), { duration: 560, delay: k * 80, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = async () => {
    if (busy) return;
    if (!open) { justOpened.current = true; setOpen(true); return; }
    const els = cardEls.current.filter(Boolean);
    if (!reduceMotion() && els.length) {
      setBusy(true);
      await Promise.all(els.slice().reverse().map((el, k) => {
        const frames = path(el).slice().reverse().map((f, i, all) => ({ ...f, offset: f.offset == null ? (i === 0 ? 0 : i === all.length - 1 ? 1 : undefined) : 1 - f.offset }));
        return el.animate(frames, { duration: 440, delay: k * 60, easing: 'cubic-bezier(.5,0,.7,.4)', fill: 'forwards' }).finished.catch(() => {});
      }));
      setBusy(false);
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={boxRef}
        type="button"
        className="m-box"
        data-card-hl={item.id}
        aria-expanded={open}
        aria-label={tp('{n} card on this passage', '{n} cards on this passage', item.cards.length)}
        onClick={toggle}
      >
        <DeckBox size="sm" count={item.cards.length} edge={edge} />
      </button>
      {open && item.cards.map((card, k) => (
        <MarginCard
          key={card.globalHash ?? k}
          card={card}
          hlId={item.id}
          canEdit={canEdit}
          onEdit={onEdit}
          cardRef={(el) => { cardEls.current[k] = el; }}
        />
      ))}
    </>
  );
}

export default function MarginCards({ scrollerRef, measure = domMeasure, highlights, flashcards, relayoutKey, canEdit, onEditCard, onShownChange, outsideLinked = null }) {
  const { t } = useT();
  const items = useMemo(() => marginItems(highlights, flashcards), [highlights, flashcards]);
  const [wide, setWide] = useState(false);
  const [linked, setLinked] = useState(null);
  const itemEls = useRef(new Map());
  const columnRef = useRef(null);
  const frame = useRef(0);
  const shown = wide && items.length > 0;

  useEffect(() => { onShownChange?.(shown); }, [shown, onShownChange]);
  useEffect(() => () => onShownChange?.(false), [onShownChange]);

  const layout = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const box = sc.getBoundingClientRect();
      const z = sc.offsetHeight ? box.height / sc.offsetHeight : 1;
      const { anchors, right } = measure(sc, box, z);
      if (columnRef.current) columnRef.current.style.left = right ? `${marginLeft(right, sc.clientWidth, columnRef.current.offsetWidth)}px` : '';
      const entries = [...itemEls.current.entries()].map(([id, el]) => ({ id, anchor: anchors.get(id) ?? null, height: el.offsetHeight }));
      const { tops } = stackTops(entries);
      for (const [id, el] of itemEls.current) {
        const top = tops.get(id);
        el.style.display = top == null ? 'none' : '';
        if (top != null) el.style.top = `${top}px`;
      }
    });
  }, [scrollerRef, measure]);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return undefined;
    const measureWidth = () => setWide(marginFits(sc.clientWidth));
    measureWidth();
    const ro = new ResizeObserver(() => { measureWidth(); layout(); });
    ro.observe(sc);
    for (const child of sc.children) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of sc.children) ro.observe(child);
      layout();
    });
    mo.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-hl'] });
    document.fonts?.ready.then(layout).catch(() => {});
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame.current); };
  }, [scrollerRef, layout]);

  useLayoutEffect(() => { if (shown) layout(); }, [shown, items, relayoutKey, layout]);

  useEffect(() => {
    if (!shown) return undefined;
    const ro = new ResizeObserver(() => layout());
    itemEls.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [shown, items, layout]);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc || !shown) return undefined;
    const over = (e) => {
      const el = e.target.closest?.('[data-hl]');
      if (el && !el.closest('.doc-margin')) setLinked(el.getAttribute('data-hl'));
    };
    const out = (e) => {
      const el = e.target.closest?.('[data-hl]');
      if (el && !el.contains(e.relatedTarget)) setLinked(null);
    };
    sc.addEventListener('pointerover', over);
    sc.addEventListener('pointerout', out);
    return () => { sc.removeEventListener('pointerover', over); sc.removeEventListener('pointerout', out); };
  }, [scrollerRef, shown]);

  const lit = linked ?? outsideLinked;

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc || !lit) return undefined;
    const marks = [...sc.querySelectorAll(`[data-hl="${CSS.escape(lit)}"]`)].filter((m) => !m.closest('.doc-margin'));
    marks.forEach((m) => m.classList.add('is-linked'));
    return () => marks.forEach((m) => m.classList.remove('is-linked'));
  }, [scrollerRef, lit]);

  if (!shown) return null;

  return (
    <div ref={columnRef} className="doc-margin" aria-label={t('Cards beside the text')}>
      {items.map((item) => (
        <div
          key={item.id}
          ref={(el) => { if (el) itemEls.current.set(item.id, el); else itemEls.current.delete(item.id); }}
          className={`m-item${lit === item.id ? ' is-linked' : ''}`}
          style={{ '--hl': hlColor(item.color) }}
          onPointerEnter={() => setLinked(item.id)}
          onPointerLeave={() => setLinked(null)}
        >
          {item.cards.length === 0 && <span className="m-tick" data-card-hl={item.id} title={t('Highlight with no card')} />}
          {item.cards.length === 1 && <MarginCard card={item.cards[0]} hlId={item.id} canEdit={canEdit} onEdit={onEditCard} />}
          {item.cards.length > 1 && <MarginBox item={item} canEdit={canEdit} onEdit={onEditCard} onToggled={layout} />}
        </div>
      ))}
    </div>
  );
}
