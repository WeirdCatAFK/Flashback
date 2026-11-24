const CONTEXT = 200;

/** Finds a highlight's text and up to 200 characters around it in a text body. Offsets win when they still fit the body, and the stored text is the fallback. */
export function resolveTextAndContext(h, body) {
    let text = typeof h.text === 'string' && h.text.length ? h.text : null;
    let start = null, end = null;

    if (body != null) {
        const hasOffsets = Number.isFinite(h.start) && Number.isFinite(h.end)
            && h.end > h.start && h.end <= body.length;
        if (hasOffsets && (h.type ?? 'text_offset') === 'text_offset') {
            start = h.start;
            end = h.end;
            if (!text) text = body.slice(start, end);
        } else if (text) {
            const idx = body.indexOf(text);
            if (idx !== -1) { start = idx; end = idx + text.length; }
        }
    }

    let context = null;
    if (body != null && start !== null) {
        const from = Math.max(0, start - CONTEXT);
        const to = Math.min(body.length, end + CONTEXT);
        context = (from > 0 ? '…' : '') + body.slice(from, to) + (to < body.length ? '…' : '');
    }
    return { text, context };
}

export const listOf = (value) => (Array.isArray(value) ? value : []);
