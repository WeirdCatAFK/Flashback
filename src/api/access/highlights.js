import crypto from 'crypto';
import Files from './files.js';
import query from './query.js';
import db from './database.js';

class Highlights {
    constructor() {
        this.files = new Files();
        this.query = query;
    }

    getHighlights(relPath) {
        const sidecar = this.files.getMetadata(relPath, false);
        return sidecar?.highlights ?? [];
    }

    /**
     * Annotated highlight listing — every highlight enriched with the context an
     * agent (or list view) needs to act on it without re-deriving the data model:
     * the highlighted text, surrounding document context, and which flashcards
     * already anchor to it. Vault-wide when `path` is omitted (documents come
     * from the derived Highlights table; per-document detail always comes from
     * the sidecar, the canonical layer).
     *
     * @param {object} [opts]
     * @param {string|null} [opts.path]  Restrict to one document.
     * @param {string|null} [opts.color] Restrict to one highlight color.
     * @param {boolean} [opts.uncardedOnly] Only highlights no flashcard anchors to yet.
     * @returns {Array<object>} Newest first.
     */
    listAnnotated({ path = null, color = null, uncardedOnly = false } = {}) {
        const paths = path ? [path] : this.query.getHighlightedDocumentPaths();
        const results = [];

        for (const relPath of paths) {
            const sidecar = this.files.getMetadata(relPath, false);
            const highlights = sidecar?.highlights ?? [];
            if (!highlights.length) continue;

            // Cards anchored to each highlight: the flashcards[] side of the
            // relationship ({type:'highlight', id} locations) is authoritative;
            // the optional cardHashes[] mirror on the highlight entry is merged in.
            const anchored = new Map();
            for (const fc of sidecar?.flashcards ?? []) {
                const loc = fc?.vanillaData?.location;
                if (loc?.type === 'highlight' && loc.id && fc.globalHash) {
                    if (!anchored.has(loc.id)) anchored.set(loc.id, new Set());
                    anchored.get(loc.id).add(fc.globalHash);
                }
            }

            // Only text-bodied formats get context extraction — decoding a PDF
            // or media file through readFile would produce garbage.
            let body = null;
            if (/\.(md|txt)$/i.test(relPath)) {
                try { body = this.files.readFile(relPath).content; } catch { body = null; }
            }

            for (const h of highlights) {
                if (color && h.color !== color) continue;
                const cardHashes = new Set(anchored.get(h.id) ?? []);
                for (const ch of h.cardHashes ?? []) cardHashes.add(ch);
                if (uncardedOnly && cardHashes.size > 0) continue;

                const { text, context } = this._resolveTextAndContext(h, body);
                results.push({
                    id: h.id,
                    documentPath: relPath,
                    type: h.type ?? null,
                    color: h.color ?? null,
                    note: h.note ?? '',
                    createdAt: h.createdAt ?? null,
                    text,
                    context,
                    cardHashes: [...cardHashes],
                    hasCards: cardHashes.size > 0,
                });
            }
        }

        return results.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    }

    // Best-effort recovery of a highlight's text and its surrounding passage.
    // Sources, in order: the sidecar `text` snapshot, then character offsets
    // (plain-text anchors only — clip_range offsets index rendered textContent,
    // not the file body), then locating the snapshot verbatim in the body.
    _resolveTextAndContext(h, body) {
        const CONTEXT = 200;
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

    createHighlight(relPath, data) {
        const globalHash = data.globalHash ?? crypto.randomUUID();
        const highlight = {
            id: globalHash,
            type: data.type ?? 'text_offset',
            // Snapshot of the highlighted text (see DATAMODEL.md's sidecar spec) —
            // used by list views and re-anchoring, and the only recoverable
            // "what does this highlight say" for non-text formats.
            text: typeof data.text === 'string' && data.text.length ? data.text : null,
            start: data.start ?? null,
            end: data.end ?? null,
            page: data.page ?? null,
            bbox: data.bbox ?? null,
            color: data.color ?? 'amber',
            note: data.note ?? '',
            createdAt: data.createdAt ?? new Date().toISOString(),
        };

        return db.transaction(() => {
            const sidecar = this.files.getMetadata(relPath, false) ?? {};
            const highlights = [...(sidecar.highlights ?? []), highlight];
            this.files.writeMetadata(relPath, { ...sidecar, highlights }, false);

            const doc = this.query.getDocumentByPath(relPath);
            if (doc) {
                this.query.insertHighlight({
                    documentId: doc.id,
                    globalHash: highlight.id,
                    type: highlight.type,
                    start: highlight.start,
                    end: highlight.end,
                    page: highlight.page,
                    bbox: highlight.bbox ? JSON.stringify(highlight.bbox) : null,
                    color: highlight.color,
                    note: highlight.note,
                    createdAt: highlight.createdAt,
                });
            }
            return highlight;
        })();
    }

    updateHighlight(relPath, hash, data) {
        return db.transaction(() => {
            const sidecar = this.files.getMetadata(relPath, false) ?? {};
            let updated = null;
            const highlights = (sidecar.highlights ?? []).map(h => {
                if (h.id !== hash) return h;
                updated = { ...h, color: data.color ?? h.color, note: data.note ?? h.note };
                return updated;
            });
            if (!updated) throw new Error(`Highlight not found: ${hash}`);
            this.files.writeMetadata(relPath, { ...sidecar, highlights }, false);
            this.query.updateHighlight(hash, { color: updated.color, note: updated.note });
            return updated;
        })();
    }

    deleteHighlight(relPath, hash) {
        return db.transaction(() => {
            const sidecar = this.files.getMetadata(relPath, false) ?? {};
            const highlights = (sidecar.highlights ?? []).filter(h => h.id !== hash);
            this.files.writeMetadata(relPath, { ...sidecar, highlights }, false);
            this.query.deleteHighlight(hash);
        })();
    }

    // Called from Documents._syncDocumentHighlights when a file is imported.
    syncFromSidecar(documentId, highlightsData) {
        if (!Array.isArray(highlightsData) || highlightsData.length === 0) return;
        this.query.syncDocumentHighlights(documentId, highlightsData);
    }
}

export default new Highlights();
