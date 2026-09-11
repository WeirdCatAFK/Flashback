/**
 * Seal — Workspace versioning for the Flashback canonical layer.
 *
 * Two classes with different responsibilities:
 *   SealEventEmitter  Primitive. Called by Documents.js after each write. Stages files and
 *                     commits to the workspace git repo. No knowledge of the database.
 *   SealTools         Orchestrator. Coordinates git operations to handle
 *                     history navigation, out-of-band change detection, and SRS-aware rollback.
 */
import git, { TREE } from "isomorphic-git";
import fs from "fs";
import path from "path";
import { getWorkspacePath, getIdentity } from "../access/primitives/config.js";
import { currentAuthor } from "../requestContext.js";

const ABSENT = 0;
const UNCHANGED = 1;
const MODIFIED = 2;

function dir() {
    return getWorkspacePath();
}

function author() {
    return currentAuthor(getIdentity);
}

function normPath(p) {
    return p ? p.replace(/\\/g, "/") : p;
}

const SIDECAR_SUFFIX = ".flashback";

function isSidecar(p) {
    return p.endsWith(SIDECAR_SUFFIX);
}

/**
 * Diffs a commit's tree against its first parent (or, for a root commit, against nothing) and returns every path added/modified/deleted — sidecars and…
 *
 * @param {string} oid - Commit hash to diff.
 * @returns {Promise<{ added: string[], modified: string[], deleted: string[] }>}
 */
async function commitDiff(oid) {
    const workspace = dir();
    const added = [];
    const modified = [];
    const deleted = [];

    const commitObj = await git.readCommit({ fs, dir: workspace, oid });
    const parentOid = commitObj.commit.parent[0];

    if (!parentOid) {
        await git.walk({
            fs,
            dir: workspace,
            trees: [TREE({ ref: oid })],
            map: async (filepath, [entry]) => {
                if (filepath === "." || !entry) return;
                if ((await entry.type()) !== "blob") return;
                added.push(filepath);
            },
        });
        return { added, modified, deleted };
    }

    await git.walk({
        fs,
        dir: workspace,
        trees: [TREE({ ref: parentOid }), TREE({ ref: oid })],
        map: async (filepath, [before, after]) => {
            if (filepath === ".") return;
            const beforeType = before ? await before.type() : null;
            const afterType = after ? await after.type() : null;
            if (beforeType === "tree" || afterType === "tree") return;
            if (!before && after) added.push(filepath);
            else if (before && !after) deleted.push(filepath);
            else if (before && after && (await before.oid()) !== (await after.oid())) modified.push(filepath);
        },
    });

    return { added, modified, deleted };
}

async function stageAll(workspace, paths) {
    for (const p of paths) await git.add({ fs, dir: workspace, filepath: normPath(p) });
}

async function removeAll(workspace, paths) {
    for (const p of paths) await git.remove({ fs, dir: workspace, filepath: normPath(p) });
}

async function stageAndCommit(action, sidecarRelPath, extraRelPaths) {
    const workspace = dir();
    const normSidecar = normPath(sidecarRelPath);
    const normExtras = extraRelPaths.map(normPath);
    await stageAll(workspace, [...normExtras, normSidecar]);
    await git.commit({ fs, dir: workspace, message: `${action}: ${normSidecar}`, author: author() });
}

function editLabel(paths) {
    const sidecars = paths.filter(isSidecar);
    if (sidecars.length === 1) return sidecars[0];
    if (sidecars.length > 1) return `${sidecars.length} sidecars`;
    return paths[0];
}

/** Fired by Documents.js after each canonical write operation. */
export class SealEventEmitter {
    constructor() {
        this._commitQueue = Promise.resolve();
    }

    /**
     * Runs `task` after every commit already queued, and resolves with its result.
     *
     * @param {() => Promise<void>} task
     * @returns {Promise<void>}
     */
    _enqueue(task) {
        const run = this._commitQueue.then(task, task);
        this._commitQueue = run.then(() => {}, () => {});
        return run;
    }

    /**
     * Waits for every queued commit to land.
     *
     * It used to flush a 2 s window of coalesced review commits first. Grading a card no
     * longer writes a file, so there is nothing to coalesce and nothing to flush — draining
     * the queue is all that is left. Kept under the same name because structural operations
     * call it to keep commit order chronological.
     *
     * @returns {Promise<void>}
     */
    async flushEdits() {
        await this._commitQueue;
    }

    /**
     * Brings the emitter to a complete stop against the CURRENT vault, before the active vault changes underneath it.
     *
     * @returns {Promise<void>}
     */
    async quiesce() {
        try {
            await this.flushEdits();
        } catch (err) {
            console.error("Seal quiesce failed to drain the commit queue:", err?.stack || err);
        }
    }

    /**
     * Records the creation of a new document and its sidecar.
     *
     * @param {string} sidecarRelPath - Relative path to the new .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage alongside the sidecar (e.g. the document file itself).
     * @returns {Promise<void>}
     */
    async create(sidecarRelPath, extraRelPaths = []) {
        await this.flushEdits();
        await this._enqueue(() =>
            stageAndCommit("create", normPath(sidecarRelPath), extraRelPaths.map(normPath)));
    }

    /**
     * Records an edit to a document or its sidecar, and commits it.
     *
     * @param {string} sidecarRelPath - Relative path to the modified .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage (e.g. the document file if its content changed).
     * @returns {Promise<void>}
     */
    async edit(sidecarRelPath, extraRelPaths = []) {
        const who = author();
        const paths = [normPath(sidecarRelPath), ...extraRelPaths.map(normPath)];

        await this._enqueue(async () => {
            const workspace = dir();
            const present = paths.filter(p => fs.existsSync(path.join(workspace, p)));
            if (present.length === 0) return;
            await stageAll(workspace, present);
            await git.commit({ fs, dir: workspace, message: `edit: ${editLabel(present)}`, author: who });
        });
    }

    /**
     * Records a file or folder move.
     *
     * @param {string} oldDocRelPath - Document path before the move (used as commit label).
     * @param {string} newDocRelPath - Document path after the move (used as commit label).
     * @param {string[]} removedRelPaths - All paths to stage for removal (doc + sidecar, and all children for folders).
     * @param {string[]} addedRelPaths - All paths to stage for addition (doc + sidecar, and all children for folders).
     * @returns {Promise<void>}
     */
    async move(oldDocRelPath, newDocRelPath, removedRelPaths, addedRelPaths) {
        const normRemoved = removedRelPaths.map(normPath);
        const normAdded = addedRelPaths.map(normPath);
        const normOldDoc = normPath(oldDocRelPath);
        const normNewDoc = normPath(newDocRelPath);

        await this.flushEdits();
        const who = author();
        await this._enqueue(async () => {
            const workspace = dir();
            await removeAll(workspace, normRemoved);
            await stageAll(workspace, normAdded);
            await git.commit({ fs, dir: workspace, message: `move: ${normOldDoc} -> ${normNewDoc}`, author: who });
        });
    }

    /**
     * Records the deletion of a document and its sidecar.
     *
     * @param {string} sidecarRelPath - Relative path to the removed .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage for removal (e.g. the document file itself).
     * @returns {Promise<void>}
     */
    async delete(sidecarRelPath, extraRelPaths = []) {
        const normSidecar = normPath(sidecarRelPath);
        const allRemoved = [...extraRelPaths, sidecarRelPath].map(normPath);
        await this.flushEdits();
        const who = author();
        await this._enqueue(async () => {
            const workspace = dir();
            await removeAll(workspace, allRemoved);
            await git.commit({ fs, dir: workspace, message: `delete: ${normSidecar}`, author: who });
        });
    }
}

export class SealTools {
    /**
     * Initializes the git repository at workspaceRoot.
     *
     * @returns {Promise<void>}
     */
    async init() {
        const workspace = dir();
        const initialized = await git.resolveRef({ fs, dir: workspace, ref: "HEAD" })
            .then(() => true)
            .catch(() => false);
        if (!initialized) {
            await git.init({ fs, dir: workspace });
        }
    }

    /**
     * Returns seal commits in reverse chronological order, one page at a time.
     *
     * @param {number} [limit=20] - Maximum number of commits to return.
     * @param {string|null} [cursor=null] - Oid of the last commit already seen; the page resumes after it.
     * @returns {Promise<Array<import('isomorphic-git').ReadCommitResult & { stats: { added: number, modified: number, deleted: number, content: number } }>>}
     */
    async log(limit = 20, cursor = null) {
        const commits = await git.log({
            fs,
            dir: dir(),
            ref: cursor ?? "HEAD",
            depth: cursor ? limit + 1 : limit,
        }).catch(err => {
            if (err.code === "NotFoundError") return [];
            throw err;
        });

        const page = cursor ? commits.slice(1) : commits;

        return Promise.all(page.map(async commit => {
            const diff = await commitDiff(commit.oid);
            const changed = [...diff.added, ...diff.modified, ...diff.deleted];
            return {
                ...commit,
                stats: {
                    added: diff.added.length,
                    modified: diff.modified.length,
                    deleted: diff.deleted.length,
                    content: changed.filter(p => !isSidecar(p)).length,
                },
            };
        }));
    }

    /**
     * Returns the full paths changed by a single commit — documents, sidecars and media — categorized as added/modified/deleted against its parent.
     *
     * @param {string} oid - Commit hash to inspect.
     * @returns {Promise<{ added: string[], modified: string[], deleted: string[] }>}
     */
    async commitFiles(oid) {
        return commitDiff(oid);
    }

    /**
     * Restores the workspace canonical layer to the state at a given commit.
     *
     * Touches no schedule, and could not if it tried: progress lives in `{vault}/progress.db`,
     * which git does not track, and the sidecar's SRS fields are no longer read. This used to
     * snapshot the owner's state around the checkout and re-apply it, behind a
     * `keepSrsProgress` flag — a flag whose `false` branch never worked, because the reindex
     * after a checkout max-merged the sidecar against the database and so could not regress a
     * level. Removing it fixed a control that had always been lying.
     *
     * @param {string} ref - Commit hash or branch name to restore to.
     * @returns {Promise<void>}
     */
    async rollback(ref) {
        await git.checkout({ fs, dir: dir(), ref, force: true });
    }

    /**
     * Binds all out-of-band workdir changes (documents, sidecars, and media — everything statusMatrix reports, not just .flashback paths) into a single…
     *
     * @returns {Promise<string|null>} the new commit oid, or null when there was no drift.
     */
    async commitDrift() {
        const workspace = dir();
        const matrix = await git.statusMatrix({ fs, dir: workspace });

        const staged = [];
        const removed = [];
        for (const [filepath, head, workdir] of matrix) {
            if (workdir === MODIFIED) staged.push(filepath);
            else if (head === UNCHANGED && workdir === ABSENT) removed.push(filepath);
        }
        if (staged.length === 0 && removed.length === 0) return null;

        await stageAll(workspace, staged);
        await removeAll(workspace, removed);
        const total = staged.length + removed.length;
        const label = total === 1 ? (staged[0] ?? removed[0]) : `${total} files`;
        return git.commit({ fs, dir: workspace, message: `reconcile: ${label}`, author: author() });
    }

    /**
     * Detects .flashback sidecars that changed outside of Flashback with no seal commit.
     *
     * @returns {Promise<{ added: string[], modified: string[], deleted: string[] }>}
     */
    async inspect() {
        const matrix = await git.statusMatrix({ fs, dir: dir() });

        const added = [];
        const modified = [];
        const deleted = [];

        for (const [filepath, head, workdir] of matrix) {
            if (!isSidecar(filepath)) continue;
            if (head === ABSENT    && workdir === MODIFIED)   added.push(filepath);
            else if (head === UNCHANGED && workdir === MODIFIED)   modified.push(filepath);
            else if (head === UNCHANGED && workdir === ABSENT)     deleted.push(filepath);
        }

        return { added, modified, deleted };
    }
}

export const sealEmitter = new SealEventEmitter();
export const sealTools = new SealTools();
