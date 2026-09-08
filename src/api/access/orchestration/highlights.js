import crypto from 'crypto';
import Files from '../resources/files.js';
import { withDocument } from '../resources/pathLock.js';
import query from '../resources/query.js';
import db from '../primitives/database.js';

class Highlights {
    constructor() {
        this.files = new Files();
        this.query = query;
    }

    /** One document's highlights. */
    getHighlights(relPath) {
        const sidecar = this.files.getMetadata(relPath, false);
        return sidecar?.highlights ?? [];
    }

    /**
     * Annotated highlight listing: every highlight enriched with the context needed to act on it without re-deriving the data.
     *
     * @param {object} [opts]
     * @param {string|null} [opts.path]  Restrict to one document.
     * @param {string|null} [opts.color] Restrict to one highlight color.
     * @param {boolean} [opts.uncardedOnly] Only highlights no flashcard anchors to yet.
     * @returns {Array<object>} Newest first.
     */
    async listAnnotated({ path = null, color = null, uncardedOnly = false } = {}) {
        const paths = path ? [path] : await this.query.getHighlightedDocumentPaths();
        const results = [];

        for (const relPath of paths) {
            const sidecar = this.files.getMetadata(relPath, false);
            const highlights = sidecar?.highlights ?? [];
            if (!highlights.length) continue;

            const anchored = new Map();
            for (const fc of sidecar?.flashcards ?? []) {
                const loc = fc?.vanillaData?.location;
                if (loc?.type === 'highlight' && loc.id && fc.globalHash) {
                    if (!anchored.has(loc.id)) anchored.set(loc.id, new Set());
                    anchored.get(loc.id).add(fc.globalHash);
                }
            }

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

    /** Creates a highlight in the index and the sidecar. */
    async createHighlight(relPath, data) {
        return await withDocument(relPath, () => this._createHighlightLocked(relPath, data));
    }

    async _createHighlightLocked(relPath, data) {
        const globalHash = data.globalHash ?? crypto.randomUUID();
        const highlight = {
            id: globalHash,
            type: data.type ?? 'text_offset',
            text: typeof data.text === 'string' && data.text.length ? data.text : null,
            start: data.start ?? null,
            end: data.end ?? null,
            page: data.page ?? null,
            bbox: data.bbox ?? null,
            color: data.color ?? 'amber',
            note: data.note ?? '',
            createdAt: data.createdAt ?? new Date().toISOString(),
        };

        return await db.transaction(async () => {
            const sidecar = this.files.getMetadata(relPath, false) ?? {};
            const highlights = [...(sidecar.highlights ?? []), highlight];
            this.files.writeMetadata(relPath, { ...sidecar, highlights }, false);

            const doc = await this.query.getDocumentByPath(relPath);
            if (doc) {
                await this.query.insertHighlight({
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

    /** Updates a highlight's colour, note or anchor. */
    async updateHighlight(relPath, hash, data, { ifMatch } = {}) {
        return await withDocument(relPath, () => this._updateHighlightLocked(relPath, hash, data, ifMatch));
    }

    async _updateHighlightLocked(relPath, hash, data, ifMatch) {
        return await db.transaction(async () => {
            const sidecar = this.files.getMetadata(relPath, false) ?? {};
            let updated = null;
            const highlights = (sidecar.highlights ?? []).map(h => {
                if (h.id !== hash) return h;
                if (ifMatch && this.files.entityEtag(h) !== ifMatch) {
                    throw Object.assign(
                        new Error('This highlight changed since you last read it.'),
                        { status: 409, code: 'stale', etag: this.files.entityEtag(h) },
                    );
                }
                updated = { ...h, color: data.color ?? h.color, note: data.note ?? h.note };
                return updated;
            });
            if (!updated) throw new Error(`Highlight not found: ${hash}`);
            this.files.writeMetadata(relPath, { ...sidecar, highlights }, false);
            await this.query.updateHighlight(hash, { color: updated.color, note: updated.note });
            return updated;
        })();
    }

    /** Deletes a highlight from the index and the sidecar. */
    async deleteHighlight(relPath, hash) {
        return await withDocument(relPath, () => this._deleteHighlightLocked(relPath, hash));
    }

    async _deleteHighlightLocked(relPath, hash) {
        return await db.transaction(async () => {
            const sidecar = this.files.getMetadata(relPath, false) ?? {};
            const highlights = (sidecar.highlights ?? []).filter(h => h.id !== hash);
            this.files.writeMetadata(relPath, { ...sidecar, highlights }, false);
            await this.query.deleteHighlight(hash);
        })();
    }

    /** Reconciles a document's Highlights rows against its sidecar. */
    async syncFromSidecar(documentId, highlightsData) {
        if (!Array.isArray(highlightsData) || highlightsData.length === 0) return;
        await this.query.syncDocumentHighlights(documentId, highlightsData);
    }
}

export default new Highlights();
