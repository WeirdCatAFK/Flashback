import db from '../../primitives/database.js';

export async function getByDocumentId(documentId) {
    return await db.prepare(
        'SELECT * FROM Highlights WHERE document_id = ? ORDER BY start ASC'
    ).all(documentId);
}

export async function getByHash(hash) {
    return await db.prepare('SELECT * FROM Highlights WHERE global_hash = ?').get(hash);
}

export async function insert(data) {
    return await db.prepare(`
        INSERT INTO Highlights (document_id, global_hash, type, start, end, page, bbox, color, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        data.documentId, data.globalHash, data.type ?? 'text_offset',
        data.start ?? null, data.end ?? null, data.page ?? null,
        data.bbox ?? null, data.color ?? 'amber', data.note ?? '',
        data.createdAt ?? new Date().toISOString()
    );
}

export async function update(hash, data) {
    return await db.prepare(
        'UPDATE Highlights SET color = ?, note = ? WHERE global_hash = ?'
    ).run(data.color, data.note ?? '', hash);
}

export async function remove(hash) {
    return await db.prepare('DELETE FROM Highlights WHERE global_hash = ?').run(hash);
}

export async function getDocumentPaths() {
    return (await db.prepare(`
        SELECT DISTINCT d.relative_path
        FROM Highlights h
        JOIN Documents d ON h.document_id = d.id
        ORDER BY d.relative_path ASC
    `).all()).map(r => r.relative_path);
}

export async function syncDocument(documentId, highlightsData) {
    const existing = await getByDocumentId(documentId);
    const existingMap = new Map(existing.map(h => [h.global_hash, h]));
    const incoming = new Set();

    for (const h of highlightsData) {
        incoming.add(h.id);
        if (!existingMap.has(h.id)) {
            await insert({
                documentId,
                globalHash: h.id,
                type: h.type,
                start: h.start,
                end: h.end,
                page: h.page,
                bbox: h.bbox ? JSON.stringify(h.bbox) : null,
                color: h.color,
                note: h.note,
                createdAt: h.createdAt,
            });
        }
    }

    for (const [hash] of existingMap) {
        if (!incoming.has(hash)) await remove(hash);
    }
}
