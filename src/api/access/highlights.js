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

    createHighlight(relPath, data) {
        const globalHash = data.globalHash ?? crypto.randomUUID();
        const highlight = {
            id: globalHash,
            type: data.type ?? 'text_offset',
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
