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
import { getWorkspacePath, getIdentity } from "../access/primitives/config.js";
import { currentAuthor } from "../requestContext.js";
import query from "../access/resources/query.js";

// git.statusMatrix column values for [HEAD, workdir]
const ABSENT = 0;
const UNCHANGED = 1;
const MODIFIED = 2;

function dir() {
    return getWorkspacePath();
}

// The person, not the place. This used to author every commit as the vault name with a
// fixed `seal@flashback.local` address, so renaming a vault changed the apparent author of
// all future work and two vaults belonging to one person looked like two people.
//
// It now prefers the ACCOUNT behind the current request, falling back to the install's local
// identity. On a desktop install those are the same person — the Author account is seeded
// from that very identity — so nothing changes. On a server they are not: the install is a
// machine, and the person who made the edit is whoever presented the token.
//
// Resolved per call, which is what the vault-switch ordering in vaultSession.js depends on
// (see the quiesce note on _cancelDebounce below) and is also what makes a per-vault
// identity override land on the right commit with no further work here.
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
 * Diffs a commit's tree against its first parent (or, for a root commit, against nothing)
 * and returns every path added/modified/deleted — sidecars and the documents/media beside
 * them alike.
 *
 * This deliberately does NOT filter to .flashback paths: the UI has to be able to tell a
 * metadata-only commit (a highlight, a card, a tag — sidecar touched, document untouched)
 * from one that rewrote the document itself, and that distinction only exists if the
 * non-sidecar paths are visible here. inspect() still filters, because drift reconciliation
 * genuinely is a sidecar-only concern.
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

const EDIT_DEBOUNCE_MS = 2000;

/** Names a batch of edited paths for the commit message: the sidecar if there is one, a
 *  count if there are several, otherwise whatever file was touched. */
function editLabel(paths) {
    const sidecars = paths.filter(isSidecar);
    if (sidecars.length === 1) return sidecars[0];
    if (sidecars.length > 1) return `${sidecars.length} sidecars`;
    return paths[0];
}

/**
 * Fired by Documents.js after each canonical write operation.
 * edit() is debounced: rapid calls accumulate dirty paths and flush in a single commit
 * after EDIT_DEBOUNCE_MS of inactivity. Structural operations (create/move/delete) flush
 * any pending edits first so commit ordering stays chronological.
 * All relPath values are relative to workspaceRoot.
 */
export class SealEventEmitter {
    constructor() {
        // path -> the author who made that edit.
        //
        // A Set of paths until the accounts store existed, which was fine while every edit
        // in a process came from the same person. It does not survive a server: the timer
        // fires long after the request that armed it has finished, so author() at flush time
        // would resolve to nobody and attribute the whole batch to the machine's local
        // identity. Capturing WHO at arm time and committing one batch per author keeps the
        // history honest.
        //
        // This is a stopgap by design. Two people editing the same document within two
        // seconds still produce two commits in an arbitrary order, and the second one's diff
        // is whatever the first one left. M3 removes the debounce outright in favour of
        // version-triggered commits; until then, at least nobody is credited with an edit
        // they did not make.
        this._pendingEdits = new Map();
        this._debounceTimer = null;
    }

    _cancelDebounce() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
    }

    /**
     * Immediately commits all accumulated debounced edits — one batch commit per author.
     * Called automatically by create/move/delete to preserve chronological order.
     * Can also be called explicitly (e.g. in tests or on graceful shutdown) to force a flush.
     *
     * On a desktop install every pending edit has the same author, so this is exactly the
     * single commit it always was.
     * @returns {Promise<void>}
     */
    async flushEdits() {
        this._cancelDebounce();
        if (this._pendingEdits.size === 0) return;
        const workspace = dir();
        // Skip paths that no longer exist on disk — they may have been moved or deleted
        // by a structural operation that ran before the debounce could fire.
        const pending = [...this._pendingEdits].filter(([p]) =>
            fs.existsSync(path.join(workspace, p))
        );
        this._pendingEdits.clear();
        if (pending.length === 0) return;

        const byAuthor = new Map();
        for (const [p, who] of pending) {
            const key = `${who.name} <${who.email}>`;
            if (!byAuthor.has(key)) byAuthor.set(key, { who, paths: [] });
            byAuthor.get(key).paths.push(p);
        }

        // Sequential, not parallel: each commit takes a snapshot of the whole index, so two
        // running at once would race over what HEAD is. Files already committed by an
        // earlier author appear unchanged in the later commit and contribute no diff.
        for (const { who, paths } of byAuthor.values()) {
            await stageAll(workspace, paths);
            await git.commit({ fs, dir: workspace, message: `edit: ${editLabel(paths)}`, author: who });
        }
    }

    /**
     * Brings the emitter to a complete stop against the CURRENT vault, before the active
     * vault changes underneath it.
     *
     * dir() and author() resolve per call, so a debounce timer armed in vault A but firing
     * after the switch would stage A's sidecar paths into B's repo and author the commit
     * with B's name — silently, and only for whoever happened to edit within 2 seconds of
     * switching. Flushing first (rather than just cancelling) means those edits still land
     * where they belong instead of being dropped.
     *
     * Errors are swallowed on purpose: a vault switch must not be blocked by a repo that
     * cannot commit, and the Vault Doctor's commitDrift() sweeps up anything left unstaged.
     *
     * @returns {Promise<void>}
     */
    async quiesce() {
        try {
            await this.flushEdits();
        } catch (err) {
            console.error("Seal quiesce failed to flush pending edits:", err?.stack || err);
        } finally {
            this._cancelDebounce();
            this._pendingEdits.clear();
        }
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
        // Resolve the author NOW, while the request that caused the edit is still in scope.
        // The timer below fires outside it.
        const who = author();
        this._pendingEdits.set(normPath(sidecarRelPath), who);
        for (const p of extraRelPaths) this._pendingEdits.set(normPath(p), who);
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

        for (const p of normRemoved) this._pendingEdits.delete(p);
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
        for (const p of allRemoved) this._pendingEdits.delete(p);
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
     * Returns seal commits in reverse chronological order, one page at a time.
     *
     * Each entry carries a `stats` field diffed against its parent — {added, modified,
     * deleted} path counts plus `content`, the number of those paths that are NOT sidecars.
     * `content === 0` on an edit means nothing but metadata moved (a highlight, a card, a
     * tag), which is what lets the UI say so instead of showing a bare `.flashback` path.
     *
     * Paging is cursor-based rather than offset-based because git history is a linked list:
     * `cursor` is the oid of the last commit the caller already has, and the page starts at
     * its parent. A page shorter than `limit` means history ended.
     * @param {number} [limit=20] - Maximum number of commits to return.
     * @param {string|null} [cursor=null] - Oid of the last commit already seen; the page resumes after it.
     * @returns {Promise<Array<import('isomorphic-git').ReadCommitResult & { stats: { added: number, modified: number, deleted: number, content: number } }>>}
     */
    async log(limit = 20, cursor = null) {
        // git.log is inclusive of `ref`, so when resuming we fetch one extra and drop the
        // cursor commit itself rather than handing the caller a duplicate row.
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
     * Returns the full paths changed by a single commit — documents, sidecars and media —
     * categorized as added/modified/deleted against its parent. Fetched lazily per-commit
     * (rather than bundled into log()) since a single commit — e.g. a large import — can
     * touch hundreds of paths.
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
        const srsSnapshot = keepSrsProgress ? await query.getAllFlashcardSrsState() : null;

        await git.checkout({ fs, dir: dir(), ref, force: true });

        if (srsSnapshot) {
            await query.batchRestoreFlashcardSrsState(srsSnapshot);
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
