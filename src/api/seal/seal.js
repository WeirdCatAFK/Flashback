/**
 * Seal — Workspace versioning for the Flashback canonical layer.
 *
 * Two classes with different responsibilities:
 *   SealEventEmitter  Primitive. Called by Documents.js after each write. Stages files and
 *                     commits to the workspace git repo. No knowledge of the database.
 *   SealTools         Orchestrator. Coordinates git operations with query.js to handle
 *                     history navigation, out-of-band change detection, and SRS-aware rollback.
 */
import git from "isomorphic-git";
import fs from "fs";
import { getWorkspacePath, get as getConfig } from "../access/config.js";
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
    return { name: config?.username || "flashback", email: "seal@flashback.local" };
}

async function stageAll(workspace, paths) {
    for (const p of paths) await git.add({ fs, dir: workspace, filepath: p });
}

async function removeAll(workspace, paths) {
    for (const p of paths) await git.remove({ fs, dir: workspace, filepath: p });
}

async function stageAndCommit(action, sidecarRelPath, extraRelPaths) {
    const workspace = dir();
    await stageAll(workspace, [...extraRelPaths, sidecarRelPath]);
    await git.commit({ fs, dir: workspace, message: `${action}: ${sidecarRelPath}`, author: author() });
}

/**
 * Fired by Documents.js after each canonical write operation.
 * Each method stages the affected .flashback sidecar(s) and produces one atomic commit.
 * All relPath values are relative to workspaceRoot.
 */
export class SealEventEmitter {
    /**
     * Records the creation of a new document and its sidecar.
     * For folder operations, pass all file paths within the folder — isomorphic-git
     * does not support staging directories recursively.
     * @param {string} sidecarRelPath - Relative path to the new .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage alongside the sidecar (e.g. the document file itself).
     * @returns {Promise<void>}
     */
    async create(sidecarRelPath, extraRelPaths = []) {
        await stageAndCommit("create", sidecarRelPath, extraRelPaths);
    }

    /**
     * Records an edit to a document or its sidecar.
     * @param {string} sidecarRelPath - Relative path to the modified .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage (e.g. the document file if its content changed).
     * @returns {Promise<void>}
     */
    async edit(sidecarRelPath, extraRelPaths = []) {
        await stageAndCommit("edit", sidecarRelPath, extraRelPaths);
    }

    /**
     * Records a file or folder move. Stages removals of all old paths and additions
     * of all new paths in a single commit so the history is atomic.
     * For folder moves, enumerate every affected file path — git tracks files, not directories.
     * @param {string} oldDocRelPath - Document path before the move (used as commit label).
     * @param {string} newDocRelPath - Document path after the move (used as commit label).
     * @param {string[]} removedRelPaths - All paths to stage for removal (doc + sidecar, and all children for folders).
     * @param {string[]} addedRelPaths - All paths to stage for addition (doc + sidecar, and all children for folders).
     * @returns {Promise<void>}
     */
    async move(oldDocRelPath, newDocRelPath, removedRelPaths, addedRelPaths) {
        const workspace = dir();
        await removeAll(workspace, removedRelPaths);
        await stageAll(workspace, addedRelPaths);
        await git.commit({ fs, dir: workspace, message: `move: ${oldDocRelPath} -> ${newDocRelPath}`, author: author() });
    }

    /**
     * Records the deletion of a document and its sidecar.
     * For folder deletions, enumerate all file paths within the folder.
     * @param {string} sidecarRelPath - Relative path to the removed .flashback sidecar (used as commit label).
     * @param {string[]} [extraRelPaths=[]] - Additional paths to stage for removal (e.g. the document file itself).
     * @returns {Promise<void>}
     */
    async delete(sidecarRelPath, extraRelPaths = []) {
        const workspace = dir();
        await removeAll(workspace, [...extraRelPaths, sidecarRelPath]);
        await git.commit({ fs, dir: workspace, message: `delete: ${sidecarRelPath}`, author: author() });
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
     * Returns the most recent seal commits in reverse chronological order.
     * @param {number} [limit=20] - Maximum number of commits to return.
     * @returns {Promise<import('isomorphic-git').ReadCommitResult[]>}
     */
    async log(limit = 20) {
        return git.log({ fs, dir: dir(), depth: limit });
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
