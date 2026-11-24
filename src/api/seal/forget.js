/**
 * Deletes one root entry of the workspace from every commit, and deletes the objects that only it used.
 * It writes the new history, moves the refs, and then deletes. A run after a crash finishes the work.
 */
import git, { STAGE } from "isomorphic-git";
import fs from "fs";
import path from "path";

const OID = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function readRefs(gitdir) {
    const refs = new Map();
    const packed = path.join(gitdir, "packed-refs");
    if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, "utf-8").split("\n")) {
            const [oid, ref] = line.trim().split(" ");
            if (OID.test(oid) && ref) refs.set(ref, oid);
        }
    }
    const loose = fs.readdirSync(path.join(gitdir, "refs"), { recursive: true }).map((name) => path.join("refs", name));
    for (const name of [...loose, "HEAD"]) {
        const file = path.join(gitdir, name);
        if (!fs.statSync(file).isFile()) continue;
        const value = fs.readFileSync(file, "utf-8").trim();
        if (OID.test(value)) refs.set(name.replaceAll("\\", "/"), value);
    }
    return refs;
}

/** Reads the object ids from a version 2 pack index: an 8-byte header, 256 counters of 4 bytes, then the sorted ids. */
function oidsInPack(idxFile) {
    const idx = fs.readFileSync(idxFile);
    if (idx.readUInt32BE(0) !== 0xff744f63) throw new Error(`Unknown pack index format: ${idxFile}`);
    const count = idx.readUInt32BE(8 + 255 * 4);
    return Array.from({ length: count }, (_, i) => idx.toString("hex", 1032 + i * 20, 1052 + i * 20));
}

function listObjects(gitdir) {
    const objects = path.join(gitdir, "objects");
    const packDir = path.join(objects, "pack");
    const loose = fs.readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))
        .flatMap((prefix) => fs.readdirSync(path.join(objects, prefix)).map((rest) => prefix + rest));
    const packs = (fs.existsSync(packDir) ? fs.readdirSync(packDir) : []).filter((name) => name.endsWith(".idx"))
        .map((name) => ({ stem: path.join(packDir, name.slice(0, -"idx".length)), oids: oidsInPack(path.join(packDir, name)) }));
    return { loose: loose.filter((oid) => OID.test(oid)), packs };
}

/** Orders every commit in the store after its parents. It includes the commits that no ref reaches, such as those before a rollback. */
async function commitsOldestFirst(repo, name) {
    const { loose, packs } = listObjects(repo.gitdir);
    const commits = new Map();
    for (const oid of new Set([...loose, ...packs.flatMap((pack) => pack.oids)])) {
        const { type } = await git.readObject({ ...repo, oid, format: "content" });
        if (type !== "commit") continue;
        const { commit } = await git.readCommit({ ...repo, oid });
        const { tree } = await git.readTree({ ...repo, oid: commit.tree });
        commits.set(oid, { oid, commit, tree, held: tree.find((entry) => entry.path === name)?.oid ?? null });
    }
    const order = new Set();
    const stack = [...commits.keys()];
    while (stack.length) {
        const oid = stack.at(-1);
        const waiting = commits.get(oid).commit.parent.filter((parent) => !order.has(parent));
        if (waiting.length) {
            stack.push(...waiting);
        } else {
            order.add(oid);
            stack.pop();
        }
    }
    return [...order].map((oid) => commits.get(oid));
}

/** Maps each commit to its rewritten id. A commit that changed nothing else maps to its parent, or to null when it has none. */
async function rewrite(repo, commits, name) {
    const moved = new Map();
    const heldBy = new Map();
    const treeAfter = new Map();
    for (const { oid, commit, tree, held } of commits) {
        const [first] = commit.parent;
        const parent = commit.parent.map((p) => moved.get(p)).filter(Boolean);
        const newTree = held ? await git.writeTree({ ...repo, tree: tree.filter((entry) => entry.path !== name) }) : commit.tree;
        const nothingElse = commit.parent.length <= 1
            && held !== (heldBy.get(first) ?? null)
            && newTree === (treeAfter.get(first) ?? EMPTY_TREE);
        const same = newTree === commit.tree && parent.join() === commit.parent.join();

        if (nothingElse) moved.set(oid, parent[0] ?? null);
        else if (same) moved.set(oid, oid);
        else moved.set(oid, await git.writeCommit({ ...repo, commit: { ...commit, tree: newTree, parent } }));
        heldBy.set(oid, held);
        treeAfter.set(oid, newTree);
    }
    return moved;
}

async function moveRefs(repo, moved) {
    for (const [ref, oid] of readRefs(repo.gitdir)) {
        const value = moved.get((await git.readCommit({ ...repo, oid })).oid);
        if (value) await git.writeRef({ ...repo, ref, value, force: true });
        else if (ref === "HEAD") await git.writeRef({ ...repo, ref, value: "refs/heads/master", symbolic: true, force: true });
        else await git.deleteRef({ ...repo, ref });
    }
    for (const file of ["packed-refs", "ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "logs"]) {
        fs.rmSync(path.join(repo.gitdir, file), { recursive: true, force: true });
    }
}

async function stillUsed(repo, commitOids) {
    const used = new Set();
    const stack = [];
    await git.walk({
        ...repo,
        trees: [STAGE()],
        map: async (filepath, [entry]) => {
            if (entry && await entry.type() === "blob") used.add(await entry.oid());
        },
    });
    for (const oid of commitOids) {
        used.add(oid);
        stack.push((await git.readCommit({ ...repo, oid })).commit.tree);
    }
    while (stack.length) {
        const oid = stack.pop();
        if (used.has(oid)) continue;
        used.add(oid);
        for (const entry of (await git.readTree({ ...repo, oid })).tree) {
            if (entry.type === "tree") stack.push(entry.oid);
            else used.add(entry.oid);
        }
    }
    return used;
}

/** Deletes every object outside used. It first unpacks each pack that holds one. */
async function prune(repo, used) {
    const objects = path.join(repo.gitdir, "objects");
    for (const { stem, oids } of listObjects(repo.gitdir).packs) {
        if (oids.every((oid) => used.has(oid))) continue;
        for (const oid of oids.filter((o) => used.has(o))) {
            const { type, object } = await git.readObject({ ...repo, oid, format: "content" });
            await git.writeObject({ ...repo, type, object, format: "content" });
        }
        const packDir = path.dirname(stem);
        for (const file of fs.readdirSync(packDir)) {
            if (file.startsWith(path.basename(stem)) || file.startsWith("multi-pack-index")) fs.rmSync(path.join(packDir, file), { force: true });
        }
    }
    for (const file of ["commit-graph", "commit-graphs"]) fs.rmSync(path.join(objects, "info", file), { recursive: true, force: true });
    for (const oid of listObjects(repo.gitdir).loose) {
        if (!used.has(oid)) fs.rmSync(path.join(objects, oid.slice(0, 2), oid.slice(2)), { force: true });
    }
}

/** Returns the number of commits that held the entry. The files in the workspace stay as they are. */
export async function forgetRoot(dir, name) {
    const repo = { fs, dir, gitdir: path.join(dir, ".git"), cache: {} };
    const staged = await git.listFiles(repo);
    for (const filepath of staged.filter((file) => file.startsWith(`${name}/`))) await git.remove({ ...repo, filepath });

    const commits = await commitsOldestFirst(repo, name);
    const holding = commits.filter(({ held }) => held).length;
    if (!holding) return 0;

    const moved = await rewrite(repo, commits, name);
    await moveRefs(repo, moved);
    await prune(repo, await stillUsed(repo, new Set([...moved.values()].filter(Boolean))));
    return holding;
}
