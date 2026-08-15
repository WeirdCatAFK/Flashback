import { useEffect, useRef } from 'react';

// App zoom, and the coordinate-space rule that comes with it.
//
// App.jsx writes `--ui-zoom` on <html> (Ctrl +/-/0) and App.css applies it as
// `#app-shell { zoom: var(--ui-zoom, 1) }`. CSS `zoom` splits the renderer into
// two coordinate spaces that are easy to mix up:
//
//   viewport space (zoom-multiplied) — getBoundingClientRect(), a MouseEvent's
//     clientX/clientY, window.innerWidth/innerHeight, and anything rendered
//     OUTSIDE #app-shell (i.e. portaled to document.body).
//   layout space (unzoomed CSS px) — offsetWidth/clientWidth, inline
//     style.left/top/width, and everything rendered INSIDE #app-shell —
//     `position: fixed` included, because `zoom` scales a fixed element's own
//     offsets without making it a containing block.
//
// The rule every floating overlay in the app follows: position in LAYOUT space.
// An overlay inside #app-shell needs nothing extra; one portaled to document.body
// carries `zoom: var(--ui-zoom, 1)` in its own CSS so it scales identically.
// Geometry that arrives in viewport space is divided by the zoom at the point of
// CAPTURE, not at render — that way every placement constant downstream keeps
// reading as plain layout px and never has to know any of this.
//
// Mixing the two is what put a `position: fixed` button at `zoom × rect.top`:
// the rect was already zoom-multiplied, so Chromium applied the factor twice.

const ZOOM_CHANGED = 'flashback:ui-zoom';

export function getUiZoom() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom');
    const z = parseFloat(raw);
    return Number.isFinite(z) && z > 0 ? z : 1;
}

// A viewport-space rect in layout space. Plain object, not a DOMRect — callers
// only ever read from it.
export function toLayoutRect(rect, zoom = getUiZoom()) {
    if (!rect) return null;
    return {
        top:    rect.top    / zoom,
        left:   rect.left   / zoom,
        right:  rect.right  / zoom,
        bottom: rect.bottom / zoom,
        width:  rect.width  / zoom,
        height: rect.height / zoom,
    };
}

// The window's inner size in layout space — what an overlay inside #app-shell
// must compare against when deciding whether it would run off the screen.
export function layoutViewport(zoom = getUiZoom()) {
    return { width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}

export function notifyUiZoomChanged() {
    window.dispatchEvent(new Event(ZOOM_CHANGED));
}

// Subscribe to zoom changes. Overlays anchored to a captured rect use this to
// dismiss: a zoom change moves the element they point at, so the stored rect is
// stale in exactly the way a scroll makes it stale. Callback is held in a ref so
// the listener registers once and always calls the latest closure (same shape as
// useDataInvalidation in dataBus.js).
export function useUiZoomChange(callback) {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        const handler = () => ref.current?.();
        window.addEventListener(ZOOM_CHANGED, handler);
        return () => window.removeEventListener(ZOOM_CHANGED, handler);
    }, []);
}
