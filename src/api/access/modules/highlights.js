import crypto from 'crypto';
import * as Files from '../resources/files.js';
import { withDocument } from '../resources/pathLock.js';
import * as documentRows from '../resources/db/documents.js';
import * as flashcardRows from '../resources/db/flashcards.js';
import * as highlightRows from '../resources/db/highlights.js';
import db from '../primitives/database.js';

export function getHighlights(relPath) {
    const sidecar = Files.getMetadata(relPath, false);
    return sidecar?.highlights ?? [];
}

export async function listAnnotated({ path = null, color = null, uncardedOnly = false } = {}) {
    const paths = path ? [path] : await highlightRows.getDocumentPaths();
    const results = [];

    for (const relPath of paths) {
        const sidecar = Files.getMetadata(relPath, false);
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
            try { body = Files.readFile(relPath).content; } catch { body = null; }
        }

        for (const h of highlights) {
            if (color && h.color !== color) continue;
            const cardHashes = new Set(anchored.get(h.id) ?? []);
            for (const ch of h.cardHashes ?? []) cardHashes.add(ch);
            if (uncardedOnly && cardHashes.size > 0) continue;

            const { text, context } = _resolveTextAndContext(h, body);
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

function _resolveTextAndContext(h, body) {
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

export async function createHighlight(relPath, data) {
    return await withDocument(relPath, () => _createHighlightLocked(relPath, data));
}

async function _createHighlightLocked(relPath, data) {
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
        const sidecar = Files.getMetadata(relPath, false) ?? {};
        const highlights = [...(sidecar.highlights ?? []), highlight];
        Files.writeMetadata(relPath, { ...sidecar, highlights }, false);

        const doc = await documentRows.getByPath(relPath);
        if (doc) {
            await highlightRows.insert({
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

export async function updateHighlight(relPath, hash, data, { ifMatch } = {}) {
    return await withDocument(relPath, () => _updateHighlightLocked(relPath, hash, data, ifMatch));
}

async function _updateHighlightLocked(relPath, hash, data, ifMatch) {
    return await db.transaction(async () => {
        const sidecar = Files.getMetadata(relPath, false) ?? {};
        let updated = null;
        const highlights = (sidecar.highlights ?? []).map(h => {
            if (h.id !== hash) return h;
            if (ifMatch && Files.entityEtag(h) !== ifMatch) {
                throw Object.assign(
                    new Error('This highlight changed since you last read it.'),
                    { status: 409, code: 'stale', etag: Files.entityEtag(h) },
                );
            }
            updated = { ...h, color: data.color ?? h.color, note: data.note ?? h.note };
            return updated;
        });
        if (!updated) throw new Error(`Highlight not found: ${hash}`);
        Files.writeMetadata(relPath, { ...sidecar, highlights }, false);
        await highlightRows.update(hash, { color: updated.color, note: updated.note });
        return updated;
    })();
}

export async function deleteHighlight(relPath, hash) {
    return await withDocument(relPath, () => _deleteHighlightLocked(relPath, hash));
}

async function _deleteHighlightLocked(relPath, hash) {
    return await db.transaction(async () => {
        const sidecar = Files.getMetadata(relPath, false) ?? {};
        const highlights = (sidecar.highlights ?? []).filter(h => h.id !== hash);
        Files.writeMetadata(relPath, { ...sidecar, highlights }, false);
        await highlightRows.remove(hash);
    })();
}

export async function backfillCardAnchors() {
    const rows = await flashcardRows.getMissingHighlightHash();
    if (!rows.length) return 0;

    const byDocument = new Map();
    for (const r of rows) byDocument.set(r.relative_path, [...(byDocument.get(r.relative_path) ?? []), r]);

    let filled = 0;
    await db.transaction(async () => {
        for (const [relPath, cards] of byDocument) {
            let sidecar;
            try { sidecar = Files.getMetadata(relPath, false); } catch { continue; }
            const anchors = new Map((sidecar?.flashcards ?? []).map((fc) => [fc?.globalHash, fc?.vanillaData?.location]));
            for (const card of cards) {
                const loc = anchors.get(card.global_hash);
                if (loc?.type !== 'highlight' || typeof loc.id !== 'string') continue;
                await flashcardRows.setHighlightHash(card.id, loc.id);
                filled += 1;
            }
        }
    })();
    return filled;
}

export async function syncFromSidecar(documentId, highlightsData) {
    if (!Array.isArray(highlightsData) || highlightsData.length === 0) return;
    await highlightRows.syncDocument(documentId, highlightsData);
}
