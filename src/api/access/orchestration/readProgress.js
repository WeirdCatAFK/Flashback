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

/**
 * What counts as finished, since dropping the status enum means it has to be derived.
 *
 * Not 1.0: real books end in indices, endnotes and back matter that nobody reads, so a
 * genuinely finished document rarely reaches the last page. A manual "mark finished" writes
 * exactly 1.0, so it always clears this bar.
 */
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

    /**
     * Derives a fraction when the caller did not send one. The client normally does — epub.js
     * computes its own percentage and a PDF knows its page count — but a position is still a
     * usable resume point without one, so this is a convenience, not a requirement.
     */
    _percentOf(unit, position, total) {
        if (!Number.isFinite(total) || total <= 0) return null;
        const at = unit === "page" ? position?.page
            : unit === "section" ? position?.section
                : unit === "chars" ? position?.offset
                    : unit === "segment" ? position?.seconds
                        : null;
        if (!Number.isFinite(at)) return null;
        return clamp01(at / total);
    }

    /**
     * Row → the shape every caller above this layer sees.
     *
     * `checkStale` costs two file reads (the sidecar and, for an editable format, the body)
     * because `files.etag` is derived on demand and stored nowhere. That is nothing for one
     * document and hundreds of reads for a folder listing, so bulk callers turn it off: a
     * staleness flag matters when you are about to RESUME at an offset, not when you are
     * drawing a progress bar.
     */
    _shape(row, relPath, { checkStale = true } = {}) {
        const position = JSON.parse(row.pos);
        const furthest = JSON.parse(row.far);

        // A `chars` offset is measured against a body that can be edited underneath it. When
        // the body has changed we keep the percent (still roughly right) and drop the absolute
        // offset (certainly wrong) rather than pretending the character index still means
        // something. Other units do not drift: page 87 is page 87.
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

    /**
     * The identity a position is keyed by: the CANONICAL globalHash, read from the sidecar,
     * with the indexed row only as a fallback.
     *
     * This is not belt-and-braces. `Documents.global_hash` is derived and can disagree with the
     * sidecar — `importFile` does not always carry a caller-supplied hash through to the index
     * — and a Doctor rebuild re-derives the row FROM the sidecar, silently correcting it. A
     * position keyed to the indexed value would be orphaned by that rebuild, which is the same
     * failure `AccountProgress` avoids by keying on `card_hash` rather than a row id: only the
     * canonical identity survives a rebuild.
     */
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

        // The index disagreeing with the canonical file is a bug elsewhere, but it is a bug
        // this feature would otherwise be silently broken by: positions are keyed canonically,
        // every folder rollup joins on the indexed value, and a Doctor rebuild rewrites the
        // index from the sidecar anyway. Correcting a derived column toward its canonical
        // source is exactly what the Doctor does, so do it here rather than teaching every
        // join to second-guess the index.
        if (doc.global_hash !== hash) {
            await this.query.updateDocumentMetadata(doc.id, { globalHash: hash });
        }
        return { ...doc, global_hash: hash };
    }

    // ---------------------------------------------------------------- reads

    /** @returns {Promise<object|null>} where the caller has read to, or null if never opened. */
    async get(relPath, { scope: scopeArg } = {}) {
        const scope = this._scope(scopeArg);
        const doc = await this._docByPath(relPath);
        const row = await getReadProgress(getVaultId(), scope, doc.global_hash);
        return row ? this._shape(row, relPath) : null;
    }

    /**
     * What the caller is partway through, most recently touched first. Finished documents are
     * excluded by default — "in progress" means still going.
     */
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
            if (!doc) continue;            // document deleted; the row is harmless and kept
            out.push({
                path: doc.relative_path,
                name: doc.name,
                globalHash: row.doc_hash,
                ...this._shape(row, doc.relative_path, { checkStale: false }),
            });
        }
        return out;
    }

    // ---------------------------------------------------------------- writes

    /**
     * Records a position.
     *
     * `mode` is the whole auto-versus-manual rule and the only place the furthest mark is
     * decided:
     *   - `auto`   — always moves `position`; advances `furthest` ONLY forward, so scrolling
     *                back to check something never costs you your place.
     *   - `manual` — sets both, and may move `furthest` BACKWARDS. An explicit "I actually only
     *                got to page 20" has to be obeyable, or the mark can never be corrected.
     */
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

        // Auto never regresses the furthest mark. With no percent on either side there is
        // nothing to compare, so the existing mark stands rather than being overwritten blind.
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
     * This is what makes "make me flashcards for everything I've read" a well-formed request:
     * an assistant asks for text with the bound applied and physically cannot be handed a page
     * past the mark. Bounding is a courtesy about spoilers, not a security control — the same
     * caller can drop the bound and read the whole document.
     *
     * `readerInfo` is `mcpReader.info()`, passed in by the route rather than imported: composing
     * at the route layer is the house pattern (`routes/srs.js` does it with the sequencer), and
     * it keeps this module off the extraction path entirely.
     *
     * The bound is computed from the PERCENTAGE, not from the stored locator, because the two
     * vocabularies do not line up unit-for-unit — an EPUB position is a CFI plus a spine href
     * while the reader counts *readable* sections, and a video position is seconds while the
     * reader counts transcript blocks. A percentage crosses both without a lookup, at the cost
     * of being accurate to within one unit, which is the right trade for "do not spoil me".
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

        // No percentage means no denominator was ever recorded. Fall back to the raw locator,
        // but only when it is already in the reader's own unit — converting between them is
        // exactly what this function refuses to guess at.
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

    // ---------------------------------------------------------------- coverage

    /**
     * The deepest point in a document that any flashcard is anchored to, in `unit`.
     *
     * Cards are vault-wide — only *schedules* are personal — so this is not scoped. It is read
     * from the sidecar rather than from FlashcardReference because a highlight-anchored card
     * keeps its position in the highlight, and the sidecar holds both in one place.
     *
     * Returns null for `section`: an EPUB card is anchored by CFI, and CFIs are not orderable
     * without epub.js resolving them against the live book. Saying "unknown" is the honest
     * answer; guessing an ordinal from a CFI string is not.
     */
    _deepestCard(meta, unit) {
        if (unit === "section") return null;
        const at = [];

        for (const card of meta?.flashcards ?? []) {
            const loc = card?.vanillaData?.location;
            if (!loc?.data) continue;
            if (unit === "page" && loc.type === "pdf_location" && Number.isFinite(loc.data.page)) {
                at.push(loc.data.page);
            }
            if (unit === "segment" && loc.type === "video_timestamp" && Number.isFinite(loc.data.start)) {
                at.push(loc.data.start);
            }
            if (unit === "chars" && loc.type === "text_offset") {
                const end = loc.data.end ?? loc.data.start;
                if (Number.isFinite(end)) at.push(end);
            }
        }

        // Highlight-anchored cards — the preferred anchor type — keep their position on the
        // highlight, so a card contributes only when its highlight is actually carded.
        for (const h of meta?.highlights ?? []) {
            if (!h?.cardHashes?.length) continue;
            if (unit === "chars" && Number.isFinite(h.end)) at.push(h.end);
            if (unit === "page" && Number.isFinite(h.page)) at.push(h.page);
            if (unit === "segment" && h.type === "video_timestamp" && Number.isFinite(h.start)) at.push(h.start);
        }

        return at.length ? Math.max(...at) : null;
    }

    /**
     * How much of what the caller has read is not yet carded.
     *
     * This is the piece that turns a large import back into a to-do list: "read to page 120,
     * the last card is from page 44" names the work rather than the pile.
     */
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

        // Three different answers, and collapsing them would be the whole point missed:
        //   - cards reach past the mark      -> no gap
        //   - no cards at all                -> the gap is EVERYTHING read so far
        //   - cards exist but none can be located (EPUB CFIs, cards with no anchor)
        //                                    -> unknown, and saying "no gap" would be a lie
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
            // Distinguishes "nothing to do" from "cannot tell", which `gap: null` alone cannot.
            gapKnown: cards === 0 || cardedTo != null,
        };
    }

    // ---------------------------------------------------------------- rollups

    /**
     * Everything under a folder, aggregated: how many documents are finished, started, or
     * never opened.
     *
     * Counting rules, all of which follow from dropping the status enum:
     *   - finished   — furthest >= FINISHED_PCT
     *   - inProgress — a row exists and is not finished
     *   - unread     — no row at all. Never backfilled to a zero row; "missing means never
     *                  started" is the same convention CardProgress uses.
     *   - percent    — the mean across EVERY document in the subtree, counting unread as 0, so
     *                  the number describes the folder rather than only the parts you touched.
     *   - a document with no denominator counts as inProgress and never as finished. It stays
     *     in the total; silently dropping it would flatter the percentage.
     *
     * One query for the subtree and one for the caller's rows, joined in memory. Nothing here
     * opens a document, so a folder of 500 PDFs costs the same as a folder of five.
     */
    async rollup(folderRelPath, { scope: scopeArg, rows: preloaded } = {}) {
        const scope = this._scope(scopeArg);
        const abs = this.files.safePath(folderRelPath || "");
        const docs = await this.query.getDocumentsInTree(abs.endsWith(path.sep) ? abs : abs + path.sep);

        const rows = preloaded ?? await listReadProgress(getVaultId(), scope);
        const index = this._indexByHash(docs);

        let finished = 0, inProgress = 0, sum = 0;
        for (const row of rows) {
            const doc = index.get(row.doc_hash);
            if (!doc) continue;            // read, but not in this subtree
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

    /**
     * A rollup, labelled with the magazine when the folder is a subscription's target.
     *
     * A "subscription rollup" is exactly this and nothing more. `Subscriptions` records what a
     * publisher installed — magazine, issue, version, target path — and is not account-scoped
     * and has no completion notion of its own, so per-person progress over its folder is the
     * only place that answer can come from. The label is the whole difference between
     * "12 of 47 documents" and "12 of 47 issues".
     */
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

    /**
     * Everything the file explorer needs to draw one folder listing, in one call: each document
     * keyed by its globalHash, each immediate subfolder by its path with a subtree rollup.
     *
     * Shaped to mirror `listFolder`, which already returns a descendant-aggregated
     * `flashcardCount` for folders as well as files — so the tree keeps rendering one level at
     * a time and never issues a request per node.
     */
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
