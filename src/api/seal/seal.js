/**
 * Seal — Workspace versioning for the Flashback canonical layer.
 *
 * Two classes with different responsibilities:
 *   SealEventEmitter  Primitive. Called by Documents.js after each write. Stages files and
 *                     commits to the workspace git repo. No knowledge of the database.
 *   SealTools         Orchestrator. Coordinates git operations with query.js to handle
 *                     history navigation, out-of-band change detection, and SRS-aware rollback.
 */
import git, { TREE } from "isomorphic-git";
import fs from "fs";
import path from "path";
import { getWorkspacePath, get as getConfig } from "../access/Config.js";
import query from "../access/query.js";

// git.statusMatrix column values for [HEAD, workdir]
const ABSENT = 0;
const UNCHANGED = 1;
const MODIFIED = 2;

function dir() {
    return getWorkspacePath();
}

function author() {
    const config = getConfig();
    return { name: config?.vaultName || "flashback", email: "seal@flashback.local" };
}

function normPath(p) {
    return p ? p.replace(/\\/g, "/") : p;
}

/**
 * Diffs a commit's tree against its first parent (or, for a root commit, against nothing)
 * and returns the .flashback sidecar paths that were added/modified/deleted.
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
                if (filepath.endsWith(".flashback")) added.push(filepath);
            },
        });
        return { added, modified, deleted };
    }

    await git.walk({
        fs,
        dir: workspace,
        trees: [TREE({ ref: parentOid }), TREE({ ref: oid })],
        map: async (filepath, [before, after]) => {
            if (filepath === "." || !filepath.endsWith(".flashback")) return;
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

const EDIT_DEBOUNCE_MS = 2000;

/**
 * Fired by Documents.js after each canonical write operation.
 * edit() is debounced: rapid calls accumulate dirty paths and flush in a single commit
 * after EDIT_DEBOUNCE_MS of inactivity. Structural operations (create/move/delete) flush
 * any pending edits first so commit ordering stays chronological.
 * All relPath values are relative to workspaceRoot.
 */
export class SealEventEmitter {
    constructor() {
        this._pendingEditPaths = new Set();
        this._debounceTimer = null;
    }

    _cancelDebounce() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
    }

    /**
     * Immediately commits all accumulated debounced edits as a single batch commit.
     * Called automatically by create/move/delete to preserve chronological order.
     * Can also be called explicitly (e.g. in tests or on graceful shutdown) to force a flush.
     * @returns {Promise<void>}
     */
    async flushEdits() {
        this._cancelDebounce();
        if (this._pendingEditPaths.size === 0) return;
        const workspace = dir();
        // Skip paths that no longer exist on disk — they may have been moved or deleted
        // by a structural operation that ran before the debounce could fire.
        const paths = [...this._pendingEditPaths].filter(p =>
            fs.existsSync(path.join(workspace, p))
        );
        this._pendingEditPaths.clear();
        if (paths.length === 0) return;
        await stageAll(workspace, paths);
        const sidecars = paths.filter(p => p.endsWith(".flashback"));
        const label = sidecars.length === 1 ? sidecars[0]
            : sidecars.length > 1       ? `${sidecars.length} sidecars`
            : paths[0];
        await git.commit({ fs, dir: workspace, message: `edit: ${label}`, author: author() });
    }

    /**
     * Records the creation of a new document and its sidecar.
     * Flushes any pending debounced edits before committing so order is preserved.
     * For folder operations, pass all file paths within the folder — isomorphic-git
     * does not support staging directories recursively.
     * @param {string} sidecarRelPath - Relative path to the new .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage alongside the sidecar (e.g. the document file itself).
     * @returns {Promise<void>}
     */
    async create(sidecarRelPath, extraRelPaths = []) {
        await this.flushEdits();
        await stageAndCommit("create", normPath(sidecarRelPath), extraRelPaths.map(normPath));
    }

    /**
     * Records an edit to a document or its sidecar.
     * Calls are debounced: paths accumulate and are committed in a single batch after
     * EDIT_DEBOUNCE_MS of inactivity, so a 30-card review session produces one commit.
     * @param {string} sidecarRelPath - Relative path to the modified .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage (e.g. the document file if its content changed).
     * @returns {Promise<void>}
     */
    async edit(sidecarRelPath, extraRelPaths = []) {
        this._pendingEditPaths.add(normPath(sidecarRelPath));
        for (const p of extraRelPaths) this._pendingEditPaths.add(normPath(p));
        this._cancelDebounce();
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this.flushEdits().catch(err => console.error("[seal] flush error:", err));
        }, EDIT_DEBOUNCE_MS);
    }

    /**
     * Records a file or folder move. Drops any pending edits for the removed paths (the move
     * commit captures their final state), flushes remaining edits, then commits the move atomically.
     * For folder moves, enumerate every affected file path — git tracks files, not directories.
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

        for (const p of normRemoved) this._pendingEditPaths.delete(p);
        await this.flushEdits();
        const workspace = dir();
        await removeAll(workspace, normRemoved);
        await stageAll(workspace, normAdded);
        await git.commit({ fs, dir: workspace, message: `move: ${normOldDoc} -> ${normNewDoc}`, author: author() });
    }

    /**
     * Records the deletion of a document and its sidecar.
     * Drops any pending edits for the deleted paths, flushes remaining edits, then commits the deletion.
     * For folder deletions, enumerate all file paths within the folder.
     * @param {string} sidecarRelPath - Relative path to the removed .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage for removal (e.g. the document file itself).
     * @returns {Promise<void>}
     */
    async delete(sidecarRelPath, extraRelPaths = []) {
        const normSidecar = normPath(sidecarRelPath);
        const allRemoved = [...extraRelPaths, sidecarRelPath].map(normPath);
        for (const p of allRemoved) this._pendingEditPaths.delete(p);
        await this.flushEdits();
        const workspace = dir();
        await removeAll(workspace, allRemoved);
        await git.commit({ fs, dir: workspace, message: `delete: ${normSidecar}`, author: author() });
    }
}

export class SealTools {
    /**
     * Initializes the git repository at workspaceRoot.
     * Safe to call on every startup — skips init if HEAD already resolves.
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
     * Returns the most recent seal commits in reverse chronological order. Each entry carries
     * a `stats` field ({added, modified, deleted} counts) diffed against its parent, so the UI
     * can show change volume without fetching every file path up front.
     * @param {number} [limit=20] - Maximum number of commits to return.
     * @returns {Promise<Array<import('isomorphic-git').ReadCommitResult & { stats: { added: number, modified: number, deleted: number } }>>}
     */
    async log(limit = 20) {
        const commits = await git.log({ fs, dir: dir(), depth: limit }).catch(err => {
            if (err.code === "NotFoundError") return [];
            throw err;
        });
        return Promise.all(commits.map(async commit => {
            const diff = await commitDiff(commit.oid);
            return {
                ...commit,
                stats: { added: diff.added.length, modified: diff.modified.length, deleted: diff.deleted.length },
            };
        }));
    }

    /**
     * Returns the full .flashback sidecar paths changed by a single commit, categorized as
     * added/modified/deleted against its parent. Fetched lazily per-commit (rather than bundled
     * into log()) since a single commit — e.g. a large import — can touch hundreds of paths.
     * @param {string} oid - Commit hash to inspect.
     * @returns {Promise<{ added: string[], modified: string[], deleted: string[] }>}
     */
    async commitFiles(oid) {
        return commitDiff(oid);
    }

    /**
     * Restores the workspace canonical layer to the state at a given commit.
     *
     * SRS state lives in the database and is not embedded in git history, so rollback
     * presents a choice: revert review progress along with the content, or preserve it.
     *
     * Behaviour by keepSrsProgress:
     *   true  — Snapshot all current SRS state (keyed by globalHash) before checkout.
     *           After checkout, re-apply the snapshot to any card that still exists in
     *           the rolled-back canonical layer. Cards that no longer exist are silently
     *           dropped — their history is gone because the card itself is gone.
     *   false — SRS state reverts along with the content. The sidecars carry a snapshot
     *           of SRS state from the time of the commit, which becomes the new truth.
     *
     * In both cases the caller must rebuild the derived layer from the rolled-back sidecars
     * (e.g. by calling inspect() and reconciling) before the app is usable again.
     *
     * @param {string} ref - Commit hash or branch name to restore to.
     * @param {boolean} [keepSrsProgress=true] - Whether to preserve current review progress.
     * @returns {Promise<void>}
     */
    async rollback(ref, keepSrsProgress = true) {
        const srsSnapshot = keepSrsProgress ? query.getAllFlashcardSrsState() : null;

        await git.checkout({ fs, dir: dir(), ref, force: true });

        if (srsSnapshot) {
            query.batchRestoreFlashcardSrsState(srsSnapshot);
        }
    }

    /**
     * Binds all out-of-band workdir changes (documents, sidecars, and media —
     * everything statusMatrix reports, not just .flashback paths) into a single
     * `reconcile:` commit. Called by the Vault Doctor at the end of a repair so
     * out-of-band deletions can't silently resurrect on a later rollback, and
     * the Loose Pages panel comes back clean.
     *
     * No-drift is the common case after a rollback (HEAD already equals the
     * workdir) — nothing is committed and null is returned.
     * @returns {Promise<string|null>} the new commit oid, or null when there was no drift.
     */
    async commitDrift() {
        const workspace = dir();
        const matrix = await git.statusMatrix({ fs, dir: workspace });

        const staged = [];
        const removed = [];
        for (const [filepath, head, workdir] of matrix) {
            if (workdir === MODIFIED) staged.push(filepath);           // added or modified
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
     * Uses git's status matrix to diff HEAD against the current workdir state.
     * The caller is responsible for reconciling each category against the derived layer:
     *   - added: import the new sidecar into the database
     *   - modified: re-sync the sidecar's flashcards and metadata
     *   - deleted: remove the corresponding document/folder from the database
     * @returns {Promise<{ added: string[], modified: string[], deleted: string[] }>}
     */
    async inspect() {
        const matrix = await git.statusMatrix({ fs, dir: dir() });

        const added = [];
        const modified = [];
        const deleted = [];

        for (const [filepath, head, workdir] of matrix) {
            if (!filepath.endsWith(".flashback")) continue;
            if (head === ABSENT    && workdir === MODIFIED)   added.push(filepath);
            else if (head === UNCHANGED && workdir === MODIFIED)   modified.push(filepath);
            else if (head === UNCHANGED && workdir === ABSENT)     deleted.push(filepath);
        }

        return { added, modified, deleted };
    }
}

export const sealEmitter = new SealEventEmitter();
export const sealTools = new SealTools();
