/**
 * Serialization for canonical writes — the lock that makes a shared vault safe to write to.
 *
 * ## What it protects, and why the database's own lock is not enough
 *
 * `db.transaction()` (see primitives/sqliteAdapter.js) holds an exclusive lock for the length
 * of its body, so the derived index is already safe from interleaving. The canonical layer is
 * not: a document write touches the filesystem BEFORE it opens that transaction
 * (`documents.updateFile` writes the body and sidecar, then syncs the index), and `move()`
 * goes further — it moves on disk first and rolls the filesystem back by hand if the
 * transaction throws. Between those two steps another request is free to run.
 *
 * The filesystem has no transactions to borrow, so the serialization has to be explicit.
 *
 * ## The shape: readers–writer over the workspace tree
 *
 * Two kinds of write, with different scopes:
 *
 *   - `withDocument(relPath, fn)` — an edit to ONE document. Exclusive against other writes
 *     to the same path, shared with edits to any other path. This is the common case and it
 *     stays concurrent, which matters: several readers annotating different documents is
 *     exactly what a server is for.
 *
 *   - `withStructure(fn)` — a move, rename, copy or delete. Exclusive against EVERYTHING,
 *     because the paths those operations invalidate are not knowable from the operation
 *     alone: moving a folder renames every document beneath it, and an edit already in
 *     flight against one of them holds a path that is about to stop existing.
 *
 * Tree-wide exclusivity for structural operations, rather than locking the subtree, is a
 * deliberate trade. Structural operations are rare and short; subtree containment checks
 * (prefix matching across two path spellings, on a case-insensitive filesystem, while a
 * rename is halfway applied) are exactly where this class of lock goes wrong. A correct
 * coarse lock beats a clever one.
 *
 * Writers do not starve: a waiting structural operation blocks documents that arrive after
 * it, so a steady stream of edits cannot postpone a move indefinitely.
 *
 * ## Scope, stated plainly
 *
 * **This is an in-process lock.** It is the right scope for every deployment this project
 * describes — the desktop app and a server host each run exactly one API process, and
 * `documents.js` is the only writer of canonical files. It is NOT a file lock: two API
 * processes over one vault remain unsupported, and anything written to the workspace from
 * outside the app is the Vault Doctor's job, not this module's.
 *
 * Tier 2 (resources). Imports nothing — it holds no path knowledge beyond using the string
 * as a key, which is what lets `tests/conflicts.test.js` exercise it without a SQLite binary.
 */

/**
 * Normalizes a path into a lock key. Not a security boundary — `Files.safePath()` is, and it
 * has already run by the time anything here is called. This only has to be stable enough
 * that two spellings of one document do not take two different locks.
 *
 * @param {string} relPath
 * @returns {string}
 */
function key(relPath) {
    return String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

class PathLock {
    constructor() {
        /** True while a structural operation owns the tree. */
        this._structureHeld = false;
        /** How many document writes are currently running. */
        this._documentCount = 0;
        /** Resolvers for structural operations waiting for the tree to drain. @type {Array<() => void>} */
        this._waitingWriters = [];
        /** Resolvers for document writes waiting behind a structural operation. @type {Array<() => void>} */
        this._waitingReaders = [];
        /** key -> promise chain tail, so writes to one document serialize. @type {Map<string, Promise<void>>} */
        this._perPath = new Map();
    }

    /**
     * Runs `fn` with the tree held shared and `relPath` held exclusively.
     *
     * @template T
     * @param {string} relPath  workspace-relative path of the document being written.
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withDocument(relPath, fn) {
        await this._acquireShared();
        try {
            return await this._runExclusiveOnPath(key(relPath), fn);
        } finally {
            this._releaseShared();
        }
    }

    /**
     * Runs `fn` with the whole tree held exclusively. Nothing else — document write or
     * structural operation — runs until it resolves.
     *
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withStructure(fn) {
        await this._acquireExclusive();
        try {
            return await fn();
        } finally {
            this._releaseExclusive();
        }
    }

    /**
     * True when nothing holds the lock. For tests and for shutdown checks; never branch on
     * it to decide whether to lock — that is a race by construction.
     * @returns {boolean}
     */
    isIdle() {
        return !this._structureHeld
            && this._documentCount === 0
            && this._waitingWriters.length === 0
            && this._waitingReaders.length === 0;
    }

    // ---------- internals ----------
    //
    // Both acquire loops are wake-all-and-re-check rather than hand-off: whoever is woken
    // re-tests its own condition and re-queues if it lost the race. That costs a few extra
    // microtasks under contention and removes the class of bug where a hand-off resolves a
    // waiter whose condition changed between the wake and the resume.

    async _acquireShared() {
        // Queue behind a structural operation that HOLDS the tree or is WAITING for it.
        // Waiting counts, and it is the whole anti-starvation rule: without it a steady
        // stream of document edits would postpone a move indefinitely.
        while (this._structureHeld || this._waitingWriters.length > 0) {
            await new Promise(resolve => this._waitingReaders.push(resolve));
        }
        this._documentCount++;
    }

    _releaseShared() {
        this._documentCount--;
        // Only a writer can be unblocked by the last document write finishing; other
        // document writes were never blocked by this one.
        if (this._documentCount === 0) this._wake(this._waitingWriters);
    }

    async _acquireExclusive() {
        while (this._structureHeld || this._documentCount > 0) {
            await new Promise(resolve => this._waitingWriters.push(resolve));
        }
        this._structureHeld = true;
    }

    _releaseExclusive() {
        this._structureHeld = false;
        // Writers first: a second structural operation that was already waiting should not
        // have to queue behind the documents that piled up behind the first one.
        if (this._waitingWriters.length > 0) this._wake(this._waitingWriters);
        else this._wake(this._waitingReaders);
    }

    /** Empties a wait list and resolves everyone on it; each re-checks and may re-queue. */
    _wake(list) {
        const waiting = list.splice(0, list.length);
        for (const resolve of waiting) resolve();
    }

    /**
     * Chains `fn` onto whatever is already queued for this path, so two writes to one
     * document never overlap. The chain entry is deleted only if nothing else joined it,
     * which is what keeps the map from growing with every document ever written.
     */
    async _runExclusiveOnPath(k, fn) {
        const previous = this._perPath.get(k) ?? Promise.resolve();
        let release;
        const mine = new Promise(resolve => { release = resolve; });
        // Held in a variable, not recomputed: `previous.then(...)` returns a NEW promise on
        // every call, so comparing against a fresh one below would never match and the map
        // would grow by one entry per document written, forever.
        const tail = previous.then(() => mine);
        this._perPath.set(k, tail);

        await previous;
        try {
            return await fn();
        } finally {
            release();
            // Only the last writer in the chain clears the entry; if someone else joined
            // behind us they have already replaced the tail and are still waiting on it.
            if (this._perPath.get(k) === tail) this._perPath.delete(k);
        }
    }
}

const pathLock = new PathLock();

export const withDocument = (relPath, fn) => pathLock.withDocument(relPath, fn);
export const withStructure = (fn) => pathLock.withStructure(fn);
export const isIdle = () => pathLock.isIdle();

export { PathLock };
export default pathLock;
