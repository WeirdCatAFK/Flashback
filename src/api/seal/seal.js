import git, { TREE } from "isomorphic-git";
import fs from "fs";
import path from "path";
import { forgetRoot } from "./forget.js";
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
const PRIVATE_ROOT = "_diary/";

function isSidecar(p) {
    return p.endsWith(SIDECAR_SUFFIX);
}

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

class SealEventEmitter {
    constructor() {
        this._commitQueue = Promise.resolve();
    }

    _enqueue(task) {
        const run = this._commitQueue.then(task, task);
        this._commitQueue = run.then(() => {}, () => {});
        return run;
    }

    async flushEdits() {
        await this._commitQueue;
    }

    async quiesce() {
        try {
            await this.flushEdits();
        } catch (err) {
            console.error("Seal quiesce failed to drain the commit queue:", err?.stack || err);
        }
    }

    async create(sidecarRelPath, extraRelPaths = []) {
        await this.flushEdits();
        await this._enqueue(() =>
            stageAndCommit("create", normPath(sidecarRelPath), extraRelPaths.map(normPath)));
    }

    async edit(sidecarRelPath, extraRelPaths = [], removedRelPaths = []) {
        const who = author();
        const paths = [normPath(sidecarRelPath), ...extraRelPaths.map(normPath)];
        const removed = removedRelPaths.map(normPath);

        await this._enqueue(async () => {
            const workspace = dir();
            const present = paths.filter(p => fs.existsSync(path.join(workspace, p)));
            const gone = removed.filter(p => !fs.existsSync(path.join(workspace, p)));
            if (present.length === 0 && gone.length === 0) return;
            await stageAll(workspace, present);
            await removeAll(workspace, gone);
            await git.commit({ fs, dir: workspace, message: `edit: ${editLabel(present.length ? present : gone)}`, author: who });
        });
    }

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

class SealTools {
    async init() {
        const workspace = dir();
        const initialized = await git.resolveRef({ fs, dir: workspace, ref: "HEAD" })
            .then(() => true)
            .catch(() => false);
        if (!initialized) {
            await git.init({ fs, dir: workspace });
        }
    }

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

    async commitFiles(oid) {
        return commitDiff(oid);
    }

    async rollback(ref) {
        await git.checkout({ fs, dir: dir(), ref, force: true });
    }

    /** Rewrites the history, so call it only while nothing else writes to the repository. */
    async forget(rootEntry) {
        return forgetRoot(dir(), rootEntry);
    }

    async commitDrift() {
        const workspace = dir();
        const matrix = await git.statusMatrix({ fs, dir: workspace });

        const staged = [];
        const removed = [];
        for (const [filepath, head, workdir] of matrix) {
            if (filepath.startsWith(PRIVATE_ROOT)) continue;
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
