/**
 * Erases _diary/ from a vault's Seal history. An older build committed diary entries there.
 * The app must be closed, because Seal writes to the same repository.
 */
import fs from 'fs';
import path from 'path';
import * as git from 'isomorphic-git';

const OID = /^[0-9a-f]{40}$/;

function readRefs(gitDir) {
    const refs = new Map();
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf-8').split('\n')) {
            const [oid, ref] = line.trim().split(' ');
            if (OID.test(oid) && ref) refs.set(ref, oid);
        }
    }
    const loose = fs.readdirSync(path.join(gitDir, 'refs'), { recursive: true }).map((name) => path.join('refs', name));
    for (const name of [...loose, 'HEAD']) {
        const file = path.join(gitDir, name);
        if (!fs.statSync(file).isFile()) continue;
        const value = fs.readFileSync(file, 'utf-8').trim();
        if (OID.test(value)) refs.set(name.replaceAll('\\', '/'), value);
    }
    return refs;
}

/** Reads the commits that the refs reach, with every parent before its children. */
async function commitsOldestFirst(repo, tips) {
    const commits = new Map();
    const order = new Set();
    const stack = [...tips];
    while (stack.length) {
        const oid = stack.at(-1);
        if (!commits.has(oid)) {
            const { commit } = await git.readCommit({ ...repo, oid });
            const { tree } = await git.readTree({ ...repo, oid: commit.tree });
            commits.set(oid, { commit, tree, diary: tree.find((entry) => entry.path === '_diary')?.oid ?? null });
        }
        const waiting = commits.get(oid).commit.parent.filter((parent) => !order.has(parent));
        if (waiting.length) {
            stack.push(...waiting);
        } else {
            order.add(oid);
            stack.pop();
        }
    }
    return [...order].map((oid) => ({ oid, ...commits.get(oid) }));
}

/** Maps each commit to its rewritten id. A commit that held only diary changes maps to its parent. */
async function rewrite(repo, commits) {
    const moved = new Map();
    const treeBefore = new Map();
    const treeAfter = new Map();
    for (const { oid, commit, tree, diary } of commits) {
        const parent = commit.parent.map((p) => moved.get(p));
        const newTree = diary
            ? await git.writeTree({ ...repo, tree: tree.filter((entry) => entry.path !== '_diary') })
            : commit.tree;
        const [first] = commit.parent;
        const onlyDiary = commit.parent.length === 1 && commit.tree !== treeBefore.get(first) && newTree === treeAfter.get(first);
        const unchanged = newTree === commit.tree && parent.every((p, i) => p === commit.parent[i]);

        if (onlyDiary) moved.set(oid, parent[0]);
        else if (unchanged) moved.set(oid, oid);
        else moved.set(oid, await git.writeCommit({ ...repo, commit: { ...commit, tree: newTree, parent } }));
        treeBefore.set(oid, commit.tree);
        treeAfter.set(oid, newTree);
    }
    return moved;
}

async function reachable(repo, tips) {
    const found = new Set();
    const stack = tips.map((oid) => ({ oid, type: 'commit' }));
    while (stack.length) {
        const { oid, type } = stack.pop();
        if (found.has(oid)) continue;
        found.add(oid);
        if (type === 'commit') {
            const { commit } = await git.readCommit({ ...repo, oid });
            stack.push({ oid: commit.tree, type: 'tree' }, ...commit.parent.map((p) => ({ oid: p, type: 'commit' })));
        } else if (type === 'tree') {
            stack.push(...(await git.readTree({ ...repo, oid })).tree.filter((entry) => entry.type !== 'commit'));
        }
    }
    return found;
}

/** Reads the object ids from a version 2 pack index: an 8-byte header, 256 counters of 4 bytes, then the sorted ids. */
function oidsInPack(idxFile) {
    const idx = fs.readFileSync(idxFile);
    if (idx.readUInt32BE(0) !== 0xff744f63) throw new Error(`Unknown pack index format: ${idxFile}`);
    const count = idx.readUInt32BE(8 + 255 * 4);
    return Array.from({ length: count }, (_, i) => idx.toString('hex', 1032 + i * 20, 1052 + i * 20));
}

/** Deletes every object outside keep. It first unpacks each pack that holds one. */
async function prune(repo, keep) {
    const objects = path.join(repo.gitdir, 'objects');
    const packDir = path.join(objects, 'pack');
    const packs = fs.existsSync(packDir) ? fs.readdirSync(packDir).filter((name) => name.endsWith('.idx')) : [];
    for (const idx of packs) {
        const oids = oidsInPack(path.join(packDir, idx));
        if (oids.every((oid) => keep.has(oid))) continue;
        for (const oid of oids.filter((o) => keep.has(o))) {
            const { type, object } = await git.readObject({ ...repo, oid, format: 'content' });
            await git.writeObject({ ...repo, type, object, format: 'content' });
        }
        const stem = idx.slice(0, -'idx'.length);
        for (const name of fs.readdirSync(packDir).filter((n) => n.startsWith(stem) || n.startsWith('multi-pack-index'))) {
            fs.rmSync(path.join(packDir, name), { force: true });
        }
    }
    for (const name of ['commit-graph', 'commit-graphs']) fs.rmSync(path.join(objects, 'info', name), { recursive: true, force: true });

    for (const prefix of fs.readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))) {
        for (const rest of fs.readdirSync(path.join(objects, prefix))) {
            if (!keep.has(prefix + rest)) fs.rmSync(path.join(objects, prefix, rest), { force: true });
        }
    }
}

export async function scrubDiary(vaultDir) {
    const workspace = path.join(vaultDir, 'workspace');
    const gitdir = path.join(workspace, '.git');
    if (!fs.existsSync(gitdir)) throw new Error(`No Seal history in ${vaultDir}. Pass the vault folder itself.`);
    if (fs.existsSync(path.join(workspace, '_diary'))) {
        throw new Error('The workspace still holds _diary/. Open the vault once in Flashback, which moves the entries, then close it and run this again.');
    }

    const repo = { fs, dir: workspace, gitdir, cache: {} };
    const refs = new Map();
    for (const [ref, oid] of readRefs(gitdir)) refs.set(ref, (await git.readCommit({ ...repo, oid })).oid);

    const commits = await commitsOldestFirst(repo, refs.values());
    const diaryOf = new Map(commits.map(({ oid, diary }) => [oid, diary]));
    const touching = commits.filter(({ diary, commit }) => diary !== (diaryOf.get(commit.parent[0]) ?? null));
    if (touching.length === 0) return { commits: 0, backup: null };

    const backup = path.join(vaultDir, `seal-backup-${Date.now()}.git`);
    fs.cpSync(gitdir, backup, { recursive: true });

    try {
        const moved = await rewrite(repo, commits);
        for (const [ref, oid] of refs) await git.writeRef({ ...repo, ref, value: moved.get(oid), force: true });
        for (const name of ['packed-refs', 'ORIG_HEAD', 'FETCH_HEAD', 'COMMIT_EDITMSG', 'logs']) {
            fs.rmSync(path.join(gitdir, name), { recursive: true, force: true });
        }
        const staged = await git.listFiles({ ...repo });
        for (const filepath of staged.filter((name) => name.startsWith('_diary/'))) await git.remove({ ...repo, filepath });

        await prune(repo, await reachable(repo, [...refs.values()].map((oid) => moved.get(oid))));
    } catch (err) {
        fs.cpSync(backup, gitdir, { recursive: true });
        throw err;
    }
    return { commits: touching.length, backup };
}
