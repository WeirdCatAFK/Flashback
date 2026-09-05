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
     *
     * `section` is deliberately absent, and that is the whole point of this function's shape.
     * A page is 1/total of a PDF and a character offset is offset/length of a text, so for
     * those the locator and the percentage are the same scale and dividing is sound. An EPUB
     * section is not: `position.section` is epub.js's SPINE index (counting cover, nav and
     * blank items), /api/reader numbers only the sections that carry text, and the percentage
     * the renderer sends is weighted by how much text is actually behind you. Three
     * vocabularies, none convertible into the others without the book open.
     *
     * Deriving one anyway is what put two scales in one column: while epub.js builds its
     * locations index the renderer has no percentage to send, this filled the gap with a
     * spine ratio, and since `auto` may only ever advance the furthest mark, that inflated
     * number then blocked every real reading report behind it. A missing percentage is the
     * honest answer, and it costs nothing that matters — the position still resumes, and
     * `readingBound` falls back to the locator when the reader's unit matches the stored one.
     */
    _percentOf(unit, position, total) {
        if (!Number.isFinite(total) || total <= 0) return null;
        const at = unit === "page" ? position?.page
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
     * Where each of a document's flashcards sits inside it, expressed in `unit`.
     *
     * Cards are vault-wide — only *schedules* are personal — so this is not scoped. It is read
     * from the sidecar rather than from `FlashcardReference` because the anchor the UI actually
     * writes keeps its geometry on the HIGHLIGHT, and `FlashcardReference` stores only what was
     * on the card: a `{type:'highlight', id}` location has no `data`, so the indexed row is
     * `(type='highlight', NULL, NULL, NULL, NULL)`. The sidecar holds the card and the
     * highlight registry in one place, which is the only place the two can be joined.
     *
     * The join is by `flashcards[].location.id` -> `highlights[].id`, NOT by the highlight's
     * `cardHashes[]`. That array is documented as an optional mirror and is never populated:
     * every renderer initialises it to `[]` and no card-creation path writes to it. Reading it
     * was why this resolved nothing for any card the app itself made.
     *
     * A `null` value means "this card cannot be located", which is a different answer from
     * "this card is at 0" and is never collapsed into one. Sources of null:
     *   - `unit === 'section'` — an EPUB card is anchored by CFI, and CFIs are not orderable
     *     without epub.js resolving them against the live book. Guessing an ordinal from a CFI
     *     string is not an answer.
     *   - a Markdown highlight, which anchors inline as `<mark data-hl>` and carries no offsets.
     *   - a card with no `location` at all, or one whose anchor type does not speak this unit.
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

        // Both anchor generations reduce to the same three shapes once resolved, so the unit
        // decides which field to read and the anchor decides which object to read it from.
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

    /**
     * The deepest point in a document that any flashcard is anchored to, in `unit`.
     *
     * `null` when nothing could be located — no cards, or none whose anchor speaks this unit.
     * Distinguishing that from "no cards at all" is `coverage`'s job, not this one's.
     */
    _deepestCard(meta, unit) {
        let deepest = null;
        for (const at of this._cardPositions(meta, unit).values()) {
            if (at != null && (deepest === null || at > deepest)) deepest = at;
        }
        return deepest;
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

    /**
     * The two lists a study session needs in order to offer only what the caller has read.
     *
     * Reading is not the scheduler's business, so this returns plain data and the composition
     * happens at the route layer — the same arrangement `/api/srs/statistics` already uses for
     * `vaultCompleteness`, and for the same reason: `srs.js` must not import an orchestrator
     * that reaches the filesystem (see ACCESS.md, "srs.js never imports documents.js").
     *
     *   documents    — every path the caller has ANY position in. A document never opened is
     *                  simply absent, which is what holds its whole pile back.
     *   excludeCards — the card hashes that are PROVABLY ahead of the mark.
     *
     * The asymmetry between those two is deliberate and is the whole policy: a document is
     * gated by whether it was opened at all, but an individual card is only ever held back on
     * positive evidence. A card whose position cannot be resolved — an EPUB CFI, a Markdown
     * inline highlight, a card with no anchor — stays in the session. The filter hides work it
     * can prove you have not reached, never work it merely cannot locate. Standalone cards
     * appear in neither list: they are drawn from no document, so there is nothing to have read.
     *
     * Cost: one accounts query and one subtree query, then one sidecar read per PARTIALLY-read
     * document. Documents never opened cost nothing, and finished ones are short-circuited
     * before the sidecar is touched.
     */
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
            if (!doc) continue;                      // a position whose document is gone
            documents.push(doc.relative_path);

            // Finished means finished: 0.95 exists precisely so back matter nobody reads does
            // not keep a book permanently short of the line, and re-deriving a page bound from
            // it would hold back the last 5% of cards on that technicality.
            if (row.far_pct != null && row.far_pct >= FINISHED_PCT) continue;

            const shape = this._shape(row, doc.relative_path);
            const bound = this._boundOf(shape);
            if (bound == null) continue;             // no usable mark -> hold nothing back

            const meta = this.files.getMetadata(doc.relative_path);
            if (!meta) continue;
            for (const [hash, at] of this._cardPositions(meta, shape.unit)) {
                if (at != null && at > bound) excludeCards.push(hash);
            }
        }

        return { documents, excludeCards };
    }

    /**
     * The furthest mark as a scalar in the document's own unit, or null when there isn't one.
     *
     * Prefers the locator over the percentage because the locator is what card positions are
     * compared against; `readingBound` makes the opposite choice, and correctly so — it is
     * converting into the READER's vocabulary, which may not be the stored one.
     *
     * The `chars` fallback matters: `_shape` deletes a character offset once the body has been
     * edited underneath it, and the percentage it keeps is still a sound bound over the new
     * length. Without the fallback, editing a note would silently unhold every card in it.
     */
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
