/**
 * Read progress — where one person has read to in one document.
 *
 * Tier 3 (orchestration). It is the only module that knows both a document's identity and a
 * reading *unit*, which is why it exists rather than living inside `documents.js`: the unit
 * vocabulary belongs to the reader, and the identity belongs to the index.
 *
 * ## Where it is stored, and why that is not where SRS progress is stored
 *
 * Everything here lives in `accounts.db`'s `ReadProgress`, for EVERYONE — the owner included,
 * under the same `OWNER_SCOPE` sentinel the rest of the app uses. That is deliberately NOT the
 * split `srs.js` makes (owner in the sidecar, everyone else in the accounts store), and the
 * two differences that justify it are specific to reading:
 *
 *   - A position moves continuously. `seal.js` justifies its review debounce with "nobody will
 *     ever roll back to the state of a card between two answers"; a scroll position is that
 *     argument several orders of magnitude over. Sidecar storage would turn reading into a
 *     commit stream, and skipping Seal would leave working-tree drift for the Doctor.
 *   - A Reader must be able to record one. `PUT /api/documents/metadata` is COLLABORATOR-gated,
 *     so a Reader cannot write a sidecar at all. Reading is not editing.
 *
 * Nothing here is derived, so a Doctor rebuild neither restores nor destroys it, and there is
 * no second canonical copy for this one to drift from.
 *
 * ## Units
 *
 * Positions are expressed in `mcpReader`'s vocabulary — `page` | `section` | `chars` |
 * `segment` — rather than a fifth one, because that is the only pagination model the renderers
 * and the MCP reader share. `GET /api/reader/read` already addresses documents in these terms,
 * which is what lets a stored position bound a text read.
 *
 * The locator is JSON and format-specific; the percent is a flat column so listings and
 * rollups stay SQL-able without parsing it.
 *
 * `total` is always supplied by the caller and never computed here. `mcpReader.info()` performs
 * a full extraction — parsing a PDF, unzipping an EPUB — so deriving a denominator on read
 * would make a 500-document folder listing parse 500 PDFs. The client already knows it.
 */
import path from "path";
import query from "../resources/query.js";
import Files from "../resources/files.js";
import { getVaultId } from "../primitives/vault.js";
import {
    saveReadProgress, getReadProgress, listReadProgress, deleteReadProgress,
} from "../primitives/accounts.js";
import { currentScope } from "../../requestContext.js";

/** The units a position may be expressed in. Mirrors mcpReader's `unit` exactly. */
export const UNITS = new Set(["page", "section", "chars", "segment"]);

/** What counts as finished, since dropping the status enum means it has to be derived. */
export const FINISHED_PCT = 0.95;

const clamp01 = (n) =>
    (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);

class ReadProgress {
    constructor() {
        this.files = new Files();
        this.query = query;
    }

    /** Whose progress this is. Resolved once per public entry point, like srs.js and diary.js. */
    _scope(explicit) {
        return explicit ?? currentScope();
    }

    /** The body half of the document etag — what a `chars` offset was measured against. */
    _bodyEtag(relPath) {
        const tag = this.files.etag(relPath);
        if (!tag) return null;
        const body = tag.split(".")[0];
        return body === "-" ? null : body;
    }

    /** Derives a fraction when the caller did not send one. */
    _percentOf(unit, position, total) {
        if (!Number.isFinite(total) || total <= 0) return null;
        const at = unit === "page" ? position?.page
            : unit === "chars" ? position?.offset
                : unit === "segment" ? position?.seconds
                    : null;
        if (!Number.isFinite(at)) return null;
        return clamp01(at / total);
    }

    /** Row → the shape every caller above this layer sees. */
    _shape(row, relPath, { checkStale = true } = {}) {
        const position = JSON.parse(row.pos);
        const furthest = JSON.parse(row.far);

        let stale = false;
        if (checkStale && row.unit === "chars" && row.body_etag && relPath) {
            stale = this._bodyEtag(relPath) !== row.body_etag;
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

    /** The identity a position is keyed by: the CANONICAL globalHash, read from the sidecar, with the indexed row only as a fallback. */
    _canonicalHash(relPath, doc) {
        return this.files.getMetadata(relPath)?.globalHash || doc?.global_hash || null;
    }

    /** hash → document, for joining a set of positions against a set of documents. */
    _indexByHash(docs) {
        const index = new Map();
        for (const doc of docs) if (doc.global_hash) index.set(doc.global_hash, doc);
        return index;
    }

    async _docByPath(relPath) {
        const doc = await this.query.getDocumentByPath(relPath);
        if (!doc) {
            throw Object.assign(new Error(`No document indexed at ${relPath}.`), { status: 404 });
        }
        const hash = this._canonicalHash(relPath, doc);
        if (!hash) {
            throw Object.assign(
                new Error(`${relPath} has no globalHash, so a reading position cannot be keyed to it.`),
                { status: 409 },
            );
        }

        if (doc.global_hash !== hash) {
            await this.query.updateDocumentMetadata(doc.id, { globalHash: hash });
        }
        return { ...doc, global_hash: hash };
    }

    /** @returns {Promise<object|null>} where the caller has read to, or null if never opened. */
    async get(relPath, { scope: scopeArg } = {}) {
        const scope = this._scope(scopeArg);
        const doc = await this._docByPath(relPath);
        const row = await getReadProgress(getVaultId(), scope, doc.global_hash);
        return row ? this._shape(row, relPath) : null;
    }

    /** What the caller is partway through, most recently touched first. */
    async listInProgress({ scope: scopeArg, limit = 50, includeFinished = false } = {}) {
        const scope = this._scope(scopeArg);
        const rows = await listReadProgress(getVaultId(), scope);
        if (rows.length === 0) return [];

        const index = this._indexByHash(await this.query.getAllDocuments());
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
                ...this._shape(row, doc.relative_path, { checkStale: false }),
            });
        }
        return out;
    }

    /** Records a position. */
    async set(relPath, { unit, position, percent, total, mode = "auto" } = {}, { scope: scopeArg } = {}) {
        const scope = this._scope(scopeArg);

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

        const doc = await this._docByPath(relPath);
        const vaultId = getVaultId();
        const pct = clamp01(percent) ?? this._percentOf(unit, position, total);
        const previous = await getReadProgress(vaultId, scope, doc.global_hash);

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

        await saveReadProgress(vaultId, scope, doc.global_hash, {
            unit,
            total: Number.isFinite(total) ? total : (previous?.total ?? null),
            pos: JSON.stringify(position),
            pos_pct: pct,
            far: JSON.stringify(far),
            far_pct: farPct,
            body_etag: unit === "chars" ? this._bodyEtag(relPath) : null,
        });

        return await this.get(relPath, { scope });
    }

    /** Forgets the caller's position in one document. */
    async clear(relPath, { scope: scopeArg } = {}) {
        const scope = this._scope(scopeArg);
        const doc = await this._docByPath(relPath);
        await deleteReadProgress(getVaultId(), scope, doc.global_hash);
    }

    /**
     * How far into a document a reader may be shown, expressed in the reader's own addressing.
     *
     * @returns {Promise<{maxIndex:number|null, maxOffset:number|null, unit:string, percent:number}>}
     */
    async readingBound(relPath, { scope: scopeArg, readerInfo } = {}) {
        const scope = this._scope(scopeArg);
        const progress = await this.get(relPath, { scope });
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

    /**
     * Where each of a document's flashcards sits inside it, expressed in `unit`.
     *
     * @returns {Map<string, number|null>} card globalHash -> position in `unit`
     */
    _cardPositions(meta, unit) {
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

    /** The deepest point in a document that any flashcard is anchored to, in `unit`. */
    _deepestCard(meta, unit) {
        let deepest = null;
        for (const at of this._cardPositions(meta, unit).values()) {
            if (at != null && (deepest === null || at > deepest)) deepest = at;
        }
        return deepest;
    }

    /** How much of what the caller has read is not yet carded. */
    async coverage(relPath, { scope: scopeArg } = {}) {
        const scope = this._scope(scopeArg);
        const progress = await this.get(relPath, { scope });
        const meta = this.files.getMetadata(relPath) ?? {};
        const cards = (meta.flashcards ?? []).length;

        if (!progress) {
            return { path: relPath, unit: null, readTo: null, cardedTo: null, cards, gap: null };
        }

        const readTo = progress.furthest?.page ?? progress.furthest?.offset
            ?? progress.furthest?.seconds ?? progress.furthest?.section ?? null;
        const cardedTo = this._deepestCard(meta, progress.unit);

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

    /** The two lists a study session needs in order to offer only what the caller has read. */
    async studyFilter({ scope: scopeArg } = {}) {
        const scope = this._scope(scopeArg);
        const abs = this.files.safePath("");
        const [docs, rows] = await Promise.all([
            this.query.getDocumentsInTree(abs.endsWith(path.sep) ? abs : abs + path.sep),
            listReadProgress(getVaultId(), scope),
        ]);
        const index = this._indexByHash(docs);

        const documents = [];
        const excludeCards = [];

        for (const row of rows) {
            const doc = index.get(row.doc_hash);
            if (!doc) continue;
            documents.push(doc.relative_path);

            if (row.far_pct != null && row.far_pct >= FINISHED_PCT) continue;

            const shape = this._shape(row, doc.relative_path);
            const bound = this._boundOf(shape);
            if (bound == null) continue;

            const meta = this.files.getMetadata(doc.relative_path);
            if (!meta) continue;
            for (const [hash, at] of this._cardPositions(meta, shape.unit)) {
                if (at != null && at > bound) excludeCards.push(hash);
            }
        }

        return { documents, excludeCards };
    }

    /** The furthest mark as a scalar in the document's own unit, or null when there isn't one. */
    _boundOf(shape) {
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

    /** Everything under a folder, aggregated: how many documents are finished, started, or never opened. */
    async rollup(folderRelPath, { scope: scopeArg, rows: preloaded } = {}) {
        const scope = this._scope(scopeArg);
        const abs = this.files.safePath(folderRelPath || "");
        const docs = await this.query.getDocumentsInTree(abs.endsWith(path.sep) ? abs : abs + path.sep);

        const rows = preloaded ?? await listReadProgress(getVaultId(), scope);
        const index = this._indexByHash(docs);

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

    /** A rollup, labelled with the magazine when the folder is a subscription's target. */
    async folderRollup(folderRelPath, { scope: scopeArg, rows } = {}) {
        const rollup = await this.rollup(folderRelPath, { scope: this._scope(scopeArg), rows });
        const target = path.normalize(folderRelPath || "");
        const subs = await this.query.listSubscriptions();
        const match = subs.find((s) => s.target_path && path.normalize(s.target_path) === target);
        if (match) {
            rollup.subscription = { magazineId: match.magazine_id, issueId: match.issue_id };
        }
        return rollup;
    }

    /** Everything the file explorer needs to draw one folder listing, in one call. */
    async listForFolder(folderRelPath, { scope: scopeArg, folders = [] } = {}) {
        const scope = this._scope(scopeArg);
        const rows = await listReadProgress(getVaultId(), scope);

        const abs = this.files.safePath(folderRelPath || "");
        const docs = await this.query.getDocumentsInTree(abs.endsWith(path.sep) ? abs : abs + path.sep);
        const index = this._indexByHash(docs);

        const documents = {};
        for (const row of rows) {
            const doc = index.get(row.doc_hash);
            if (doc) documents[row.doc_hash] = this._shape(row, doc.relative_path, { checkStale: false });
        }

        const rollups = {};
        for (const child of folders) {
            rollups[child] = await this.folderRollup(child, { scope, rows });
        }

        return { documents, folders: rollups };
    }
}

export default new ReadProgress();
