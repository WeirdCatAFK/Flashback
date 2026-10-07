/** Serializes canonical writes. withDocument per path, withStructure exclusive. Path lock first, DB lock second. */

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
     * Runs `fn` with the whole tree held exclusively.
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
     * True when nothing holds the lock.
     *
     * @returns {boolean}
     */
    isIdle() {
        return !this._structureHeld
            && this._documentCount === 0
            && this._waitingWriters.length === 0
            && this._waitingReaders.length === 0;
    }

    async _acquireShared() {
        while (this._structureHeld || this._waitingWriters.length > 0) {
            await new Promise(resolve => this._waitingReaders.push(resolve));
        }
        this._documentCount++;
    }

    _releaseShared() {
        this._documentCount--;
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
        if (this._waitingWriters.length > 0) this._wake(this._waitingWriters);
        else this._wake(this._waitingReaders);
    }

    /** Empties a wait list and resolves everyone on it; each re-checks and may re-queue. */
    _wake(list) {
        const waiting = list.splice(0, list.length);
        for (const resolve of waiting) resolve();
    }

    /** Chains `fn` onto whatever is already queued for this path, so two writes to one document never overlap. */
    async _runExclusiveOnPath(k, fn) {
        const previous = this._perPath.get(k) ?? Promise.resolve();
        let release;
        const mine = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => mine);
        this._perPath.set(k, tail);

        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this._perPath.get(k) === tail) this._perPath.delete(k);
        }
    }
}

const pathLock = new PathLock();

/** Exclusive per path, shared across paths. The common case — concurrent edits to different documents. */
export const withDocument = (relPath, fn) => pathLock.withDocument(relPath, fn);
/** Exclusive against everything. For moves, renames, deletes — structural changes that invalidate paths. */
export const withStructure = (fn) => pathLock.withStructure(fn);
export const isIdle = () => pathLock.isIdle();

export { PathLock };
export default pathLock;
