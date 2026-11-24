import path from "path";
import * as documentRows from '../resources/db/documents.js';
import * as readProgressRows from '../resources/db/readProgress.js';
import * as subscriptionRows from '../resources/db/subscriptions.js';
import * as Files from '../resources/files.js';
import { currentScope } from "../../requestContext.js";

const UNITS = new Set(["page", "section", "chars", "segment"]);

export const FINISHED_PCT = 0.95;

const clamp01 = (n) =>
    (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);

function _scope(explicit) {
    return explicit ?? currentScope();
}

function _bodyEtag(relPath) {
    const tag = Files.etag(relPath);
    if (!tag) return null;
    const body = tag.split(".")[0];
    return body === "-" ? null : body;
}

function _percentOf(unit, position, total) {
    if (!Number.isFinite(total) || total <= 0) return null;
    const at = unit === "page" ? position?.page
        : unit === "chars" ? position?.offset
            : unit === "segment" ? position?.seconds
                : null;
    if (!Number.isFinite(at)) return null;
    return clamp01(at / total);
}

function _shape(row, relPath, { checkStale = true } = {}) {
    const position = JSON.parse(row.pos);
    const furthest = JSON.parse(row.far);

    let stale = false;
    if (checkStale && row.unit === "chars" && row.body_etag && relPath) {
        stale = _bodyEtag(relPath) !== row.body_etag;
        if (stale) {
            delete position.offset;
            delete furthest.offset;
        }
    }

    return {
        unit: row.unit,
        total: row.total,
        position,
        percent: row.pos_pct,
        furthest,
        furthestPercent: row.far_pct,
        finished: row.far_pct != null && row.far_pct >= FINISHED_PCT,
        stale,
        updatedAt: row.updated_at,
    };
}

function _normalizedHash(relPath, doc) {
    return Files.getMetadata(relPath)?.globalHash || doc?.global_hash || null;
}

function _indexByHash(docs) {
    const index = new Map();
    for (const doc of docs) if (doc.global_hash) index.set(doc.global_hash, doc);
    return index;
}

async function _docByPath(relPath) {
    const doc = await documentRows.getByPath(relPath);
    if (!doc) {
        throw Object.assign(new Error(`No document indexed at ${relPath}.`), { status: 404 });
    }
    const hash = _normalizedHash(relPath, doc);
    if (!hash) {
        throw Object.assign(
            new Error(`${relPath} has no globalHash, so a reading position cannot be keyed to it.`),
            { status: 409 },
        );
    }

    if (doc.global_hash !== hash) {
        await documentRows.updateMetadata(doc.id, { globalHash: hash });
    }
    return { ...doc, global_hash: hash };
}

export async function get(relPath, { scope: scopeArg } = {}) {
    const scope = _scope(scopeArg);
    const doc = await _docByPath(relPath);
    const row = await readProgressRows.get(scope, doc.global_hash);
    return row ? _shape(row, relPath) : null;
}

export async function listInProgress({ scope: scopeArg, limit = 50, includeFinished = false } = {}) {
    const scope = _scope(scopeArg);
    const rows = await readProgressRows.list(scope);
    if (rows.length === 0) return [];

    const index = _indexByHash(await documentRows.getAll());
    const out = [];
    for (const row of rows) {
        if (out.length >= limit) break;
        const finished = row.far_pct != null && row.far_pct >= FINISHED_PCT;
        if (finished && !includeFinished) continue;
        const doc = index.get(row.doc_hash);
        if (!doc) continue;
        out.push({
            path: doc.relative_path,
            name: doc.name,
            globalHash: row.doc_hash,
            ..._shape(row, doc.relative_path, { checkStale: false }),
        });
    }
    return out;
}

export async function set(relPath, { unit, position, percent, total, mode = "auto" } = {}, { scope: scopeArg } = {}) {
    const scope = _scope(scopeArg);

    if (!UNITS.has(unit)) {
        throw Object.assign(
            new Error(`Unknown reading unit "${unit}". Expected one of: ${[...UNITS].join(", ")}.`),
            { status: 400 },
        );
    }
    if (!position || typeof position !== "object") {
        throw Object.assign(new Error("A position object is required."), { status: 400 });
    }
    if (mode !== "auto" && mode !== "manual") {
        throw Object.assign(
            new Error(`Unknown mode "${mode}". Expected "auto" or "manual".`), { status: 400 },
        );
    }

    const doc = await _docByPath(relPath);
    const pct = clamp01(percent) ?? _percentOf(unit, position, total);
    const previous = await readProgressRows.get(scope, doc.global_hash);

    let far = position;
    let farPct = pct;
    if (mode === "auto" && previous) {
        const prevFar = previous.far_pct;
        const advances = pct != null && (prevFar == null || pct > prevFar);
        if (!advances) {
            far = JSON.parse(previous.far);
            farPct = prevFar;
        }
    }

    await readProgressRows.save(scope, doc.global_hash, {
        unit,
        total: Number.isFinite(total) ? total : (previous?.total ?? null),
        pos: JSON.stringify(position),
        pos_pct: pct,
        far: JSON.stringify(far),
        far_pct: farPct,
        body_etag: unit === "chars" ? _bodyEtag(relPath) : null,
    });

    return await get(relPath, { scope });
}

export async function clear(relPath, { scope: scopeArg } = {}) {
    const scope = _scope(scopeArg);
    const doc = await _docByPath(relPath);
    await readProgressRows.remove(scope, doc.global_hash);
}

export async function readingBound(relPath, { scope: scopeArg, readerInfo } = {}) {
    const scope = _scope(scopeArg);
    const progress = await get(relPath, { scope });
    if (!progress) {
        throw Object.assign(
            new Error(`You have no reading position in ${relPath}, so there is nothing to bound a read by.`),
            { status: 400 },
        );
    }

    const unit = readerInfo?.unit ?? progress.unit;
    const total = readerInfo?.total;
    let pct = progress.furthestPercent;

    if (pct == null) {
        const raw = unit === progress.unit
            ? (progress.furthest?.page ?? progress.furthest?.offset ?? progress.furthest?.section)
            : null;
        if (raw == null) {
            throw Object.assign(
                new Error(`Your position in ${relPath} has no percentage, so it cannot bound a ${unit} read.`),
                { status: 400 },
            );
        }
        return unit === "chars"
            ? { unit, percent: null, maxIndex: null, maxOffset: raw }
            : { unit, percent: null, maxIndex: raw, maxOffset: null };
    }

    if (!Number.isFinite(total) || total <= 0) {
        throw Object.assign(
            new Error(`${relPath} reports no readable length, so a read cannot be bounded.`),
            { status: 400 },
        );
    }

    return unit === "chars"
        ? { unit, percent: pct, maxIndex: null, maxOffset: Math.max(1, Math.floor(pct * total)) }
        : { unit, percent: pct, maxIndex: Math.max(1, Math.ceil(pct * total)), maxOffset: null };
}

function _cardPositions(meta, unit) {
    const positions = new Map();
    const cards = meta?.flashcards ?? [];
    if (unit === "section") {
        for (const card of cards) if (card?.globalHash) positions.set(card.globalHash, null);
        return positions;
    }

    const byId = new Map();
    for (const h of meta?.highlights ?? []) if (h?.id) byId.set(h.id, h);

    const inUnit = (type, d) => {
        if (!d) return null;
        if (unit === "page") {
            return (type === "pdf_location" || type === "pdf_bbox") && Number.isFinite(d.page)
                ? d.page : null;
        }
        if (unit === "segment") {
            return type === "video_timestamp" && Number.isFinite(d.start) ? d.start : null;
        }
        if (unit === "chars") {
            if (type !== "text_offset" && type !== "clip_range") return null;
            const end = d.end ?? d.start;
            return Number.isFinite(end) ? end : null;
        }
        return null;
    };

    for (const card of cards) {
        if (!card?.globalHash) continue;
        const loc = card?.vanillaData?.location;
        let at = null;
        if (loc?.type === "highlight" && loc.id) {
            const h = byId.get(loc.id);
            if (h) at = inUnit(h.type, h);
        } else if (loc?.data) {
            at = inUnit(loc.type, loc.data);
        }
        positions.set(card.globalHash, at);
    }
    return positions;
}

function _deepestCard(meta, unit) {
    let deepest = null;
    for (const at of _cardPositions(meta, unit).values()) {
        if (at != null && (deepest === null || at > deepest)) deepest = at;
    }
    return deepest;
}

export async function coverage(relPath, { scope: scopeArg } = {}) {
    const scope = _scope(scopeArg);
    const progress = await get(relPath, { scope });
    const meta = Files.getMetadata(relPath) ?? {};
    const cards = (meta.flashcards ?? []).length;

    if (!progress) {
        return { path: relPath, unit: null, readTo: null, cardedTo: null, cards, gap: null };
    }

    const readTo = progress.furthest?.page ?? progress.furthest?.offset
        ?? progress.furthest?.seconds ?? progress.furthest?.section ?? null;
    const cardedTo = _deepestCard(meta, progress.unit);

    let gap = null;
    if (readTo != null) {
        if (cards === 0) gap = { from: 0, to: readTo };
        else if (cardedTo != null && cardedTo < readTo) gap = { from: cardedTo, to: readTo };
    }

    return {
        path: relPath,
        unit: progress.unit,
        total: progress.total,
        readTo,
        readPercent: progress.furthestPercent,
        cardedTo,
        cardedPercent: cardedTo != null && progress.total ? clamp01(cardedTo / progress.total) : null,
        cards,
        gap,
        gapKnown: cards === 0 || cardedTo != null,
    };
}

export async function studyFilter({ scope: scopeArg } = {}) {
    const scope = _scope(scopeArg);
    const abs = Files.safePath("");
    const [docs, rows] = await Promise.all([
        documentRows.getInTree(abs.endsWith(path.sep) ? abs : abs + path.sep),
        readProgressRows.list(scope),
    ]);
    const index = _indexByHash(docs);

    const documents = [];
    const excludeCards = [];

    for (const row of rows) {
        const doc = index.get(row.doc_hash);
        if (!doc) continue;
        documents.push(doc.relative_path);

        if (row.far_pct != null && row.far_pct >= FINISHED_PCT) continue;

        const shape = _shape(row, doc.relative_path);
        const bound = _boundOf(shape);
        if (bound == null) continue;

        const meta = Files.getMetadata(doc.relative_path);
        if (!meta) continue;
        for (const [hash, at] of _cardPositions(meta, shape.unit)) {
            if (at != null && at > bound) excludeCards.push(hash);
        }
    }

    return { documents, excludeCards };
}

function _boundOf(shape) {
    const direct = shape.unit === "page" ? shape.furthest?.page
        : shape.unit === "chars" ? shape.furthest?.offset
            : shape.unit === "segment" ? shape.furthest?.seconds
                : null;
    if (Number.isFinite(direct)) return direct;
    if (shape.unit === "chars" && shape.furthestPercent != null && Number.isFinite(shape.total)) {
        return shape.furthestPercent * shape.total;
    }
    return null;
}

export async function rollup(folderRelPath, { scope: scopeArg, rows: preloaded } = {}) {
    const scope = _scope(scopeArg);
    const abs = Files.safePath(folderRelPath || "");
    const docs = await documentRows.getInTree(abs.endsWith(path.sep) ? abs : abs + path.sep);

    const rows = preloaded ?? await readProgressRows.list(scope);
    const index = _indexByHash(docs);

    let finished = 0, inProgress = 0, sum = 0;
    for (const row of rows) {
        const doc = index.get(row.doc_hash);
        if (!doc) continue;
        const pct = row.far_pct ?? 0;
        sum += pct;
        if (row.far_pct != null && row.far_pct >= FINISHED_PCT) finished += 1;
        else inProgress += 1;
    }

    const total = docs.length;
    return {
        path: folderRelPath,
        total,
        finished,
        inProgress,
        unread: total - finished - inProgress,
        percent: total > 0 ? sum / total : 0,
    };
}

export async function folderRollup(folderRelPath, { scope: scopeArg, rows } = {}) {
    const result = await rollup(folderRelPath, { scope: _scope(scopeArg), rows });
    const target = path.normalize(folderRelPath || "");
    const subs = await subscriptionRows.list();
    const match = subs.find((s) => s.target_path && path.normalize(s.target_path) === target);
    if (match) {
        result.subscription = { magazineId: match.magazine_id, issueId: match.issue_id };
    }
    return result;
}

export async function listForFolder(folderRelPath, { scope: scopeArg, folders = [] } = {}) {
    const scope = _scope(scopeArg);
    const rows = await readProgressRows.list(scope);

    const abs = Files.safePath(folderRelPath || "");
    const docs = await documentRows.getInTree(abs.endsWith(path.sep) ? abs : abs + path.sep);
    const index = _indexByHash(docs);

    const documents = {};
    for (const row of rows) {
        const doc = index.get(row.doc_hash);
        if (doc) documents[row.doc_hash] = _shape(row, doc.relative_path, { checkStale: false });
    }

    const rollups = {};
    for (const child of folders) {
        rollups[child] = await folderRollup(child, { scope, rows });
    }

    return { documents, folders: rollups };
}
