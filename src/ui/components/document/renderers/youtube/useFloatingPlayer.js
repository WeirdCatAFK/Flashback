/**
 * The small player: once the video is scrolled out of view while it plays, the player
 * floats in a corner of the document area so you can keep watching while you read or
 * write. It stays out when you pause (pausing to write a note must not take it away),
 * and goes back when the video is in view again, on Back to the video, or when closed,
 * which keeps it in place until the video has been in view once more.
 *
 * The iframe is never moved in the page, since moving an iframe reloads it: its box
 * only becomes `position: fixed` at the corner while the slot around it keeps the
 * space, so the text does not jump. It is dragged by its bar (the video itself takes
 * the pointer inside its frame) and settles into the nearest corner, remembered as
 * `fb-video-corner`. Positions are layout pixels, since the shell is zoomed.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { getPref, setPref } from '../../../../prefs.js';
import { toLayoutRect, getUiZoom, useUiZoomChange } from '../../../../utils/uiZoom';
import { cornerPosition, nearestCorner, storedCorner } from './floatCorner.js';

/** How far a press must move before it is a drag, and how long the settle into a corner runs. */
const DRAG_THRESHOLD = 5;
const SETTLE_MS = 240;
/** The video counts as out of view once less than this much of it is left at the top. */
const AWAY_MARGIN = 48;

export default function useFloatingPlayer({ slotRef, frameRef, playing, enabled = true }) {
  const [floating, setFloating] = useState(false);
  const [pos, setPos] = useState(null);
  const [corner, setCorner] = useState(() => storedCorner(getPref('fb-video-corner')));
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const closedRef = useRef(false);
  const floatingRef = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const cornerRef = useRef(corner);
  cornerRef.current = corner;
  const dragRef = useRef({ id: null, x0: 0, y0: 0, left: 0, top: 0, moving: false });

  const scroller = () => slotRef.current?.closest('.doc-editor-renderer') ?? null;

  const place = useCallback(() => {
    const slot = slotRef.current, sc = scroller();
    if (!slot || !sc || !slot.offsetParent) return;
    const r = toLayoutRect(slot.getBoundingClientRect());
    const area = toLayoutRect(sc.getBoundingClientRect());
    const away = r.bottom < area.top + AWAY_MARGIN || r.top > area.bottom;
    if (!away) closedRef.current = false;
    const want = away && !closedRef.current && (playingRef.current || floatingRef.current);
    floatingRef.current = want;
    setFloating(want);
    if (want && !dragRef.current.moving && frameRef.current) {
      const f = frameRef.current;
      const next = cornerPosition(cornerRef.current, area, f.offsetWidth, f.offsetHeight);
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => { place(); }, [floating, corner, playing, enabled, place]);

  useEffect(() => {
    const sc = scroller();
    if (!sc) return undefined;
    sc.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    return () => { sc.removeEventListener('scroll', place); window.removeEventListener('resize', place); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, enabled]);

  useUiZoomChange(place);

  const close = () => { closedRef.current = true; place(); };
  const back = () => slotRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  /**
   * A drag is followed on the window, not on the bar: the video is its own document, and a
   * pointer that crosses into it is no longer reported to this one. So the moment the bar is
   * pressed the video stops taking the pointer (`is-pressing`, set on the element directly
   * rather than waiting for a render), and moves and the release are read from the window
   * until the press ends.
   */
  const handleProps = {
    onPointerDown: (e) => {
      const f = frameRef.current;
      if (e.button > 0 || e.target.closest('button') || !f) return;
      e.preventDefault();
      const r = toLayoutRect(f.getBoundingClientRect());
      const d = { id: e.pointerId, x0: e.clientX, y0: e.clientY, left: r.left, top: r.top, moving: false };
      dragRef.current = d;
      f.classList.add('is-pressing');

      const onMove = (ev) => {
        if (ev.pointerId !== d.id) return;
        const z = getUiZoom();
        const dx = (ev.clientX - d.x0) / z, dy = (ev.clientY - d.y0) / z;
        if (!d.moving && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.moving = true;
        setDragging(true);
        setPos({ left: d.left + dx, top: d.top + dy });
      };
      const onUp = (ev) => {
        if (ev.pointerId !== d.id) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        f.classList.remove('is-pressing');
        d.id = null;
        if (!d.moving) return;
        d.moving = false;
        setDragging(false);
        const sc = scroller();
        if (sc) {
          const area = toLayoutRect(sc.getBoundingClientRect());
          const fr = toLayoutRect(f.getBoundingClientRect());
          const next = nearestCorner(fr.left + fr.width / 2, fr.top + fr.height / 2, area);
          setCorner(next);
          cornerRef.current = next;
          try { setPref('fb-video-corner', next); } catch { }
        }
        setSettling(true);
        setTimeout(() => setSettling(false), SETTLE_MS);
        place();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
  };

  return {
    floating,
    dragging,
    settling,
    corner,
    style: floating && pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined,
    handleProps,
    close,
    back,
  };
}
