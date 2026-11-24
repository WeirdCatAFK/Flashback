/**
 * Serializes canonical writes. withDocument locks one path and withStructure locks the whole tree.
 * Take the path lock before the database lock. The lock is not reentrant.
 * shortcut: the lock is in-process, so two API processes over one vault corrupt it. Add a file lock before running replicas.
 */
function key(relPath) {
    return String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

class PathLock {
    constructor() {
        this._structureHeld = false;
        this._documentCount = 0;
        this._waitingWriters = [];
        this._waitingReaders = [];
        this._perPath = new Map();
    }

    async withDocument(relPath, fn) {
        await this._acquireShared();
        try {
            return await this._runExclusiveOnPath(key(relPath), fn);
        } finally {
            this._releaseShared();
        }
    }

    async withStructure(fn) {
        await this._acquireExclusive();
        try {
            return await fn();
        } finally {
            this._releaseExclusive();
        }
    }

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

    _wake(list) {
        const waiting = list.splice(0, list.length);
        for (const resolve of waiting) resolve();
    }

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

export const withDocument = (relPath, fn) => pathLock.withDocument(relPath, fn);
export const withStructure = (fn) => pathLock.withStructure(fn);
export const isIdle = () => pathLock.isIdle();

export { PathLock };
export default pathLock;
