import { useEffect, useRef } from 'react';

const ZOOM_CHANGED = 'flashback:ui-zoom';

export function getUiZoom() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom');
    const z = parseFloat(raw);
    return Number.isFinite(z) && z > 0 ? z : 1;
}

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

export function layoutViewport(zoom = getUiZoom()) {
    return { width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}

export function notifyUiZoomChanged() {
    window.dispatchEvent(new Event(ZOOM_CHANGED));
}

export function useUiZoomChange(callback) {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        const handler = () => ref.current?.();
        window.addEventListener(ZOOM_CHANGED, handler);
        return () => window.removeEventListener(ZOOM_CHANGED, handler);
    }, []);
}
