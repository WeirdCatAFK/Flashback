/**
 * The app zoom (Ctrl+/−) and the two coordinate spaces it creates: viewport
 * pixels from getBoundingClientRect versus layout pixels inside the zoomed
 * shell. Overlays positioned from a captured rect convert with these and dismiss
 * on a zoom change.
 */

import { useEffect, useRef } from 'react';

const ZOOM_CHANGED = 'flashback:ui-zoom';

export function getUiZoom() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom');
    const z = parseFloat(raw);
    return Number.isFinite(z) && z > 0 ? z : 1;
}

/**
 * A viewport-space rect in layout space. Plain object, not a DOMRect — callers
 * only ever read from it.
 */
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

/**
 * The window's inner size in layout space — what an overlay inside #app-shell
 * must compare against when deciding whether it would run off the screen.
 */
export function layoutViewport(zoom = getUiZoom()) {
    return { width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}

export function notifyUiZoomChanged() {
    window.dispatchEvent(new Event(ZOOM_CHANGED));
}

/**
 * Subscribe to zoom changes. Overlays anchored to a captured rect use this to
 * dismiss: a zoom change moves the element they point at, so the stored rect is
 * stale in exactly the way a scroll makes it stale. Callback is held in a ref so
 * the listener registers once and always calls the latest closure (same shape as
 * useDataInvalidation in dataBus.js).
 */
export function useUiZoomChange(callback) {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        const handler = () => ref.current?.();
        window.addEventListener(ZOOM_CHANGED, handler);
        return () => window.removeEventListener(ZOOM_CHANGED, handler);
    }, []);
}
