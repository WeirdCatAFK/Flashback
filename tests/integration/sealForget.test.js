import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import * as git from 'isomorphic-git';
import { testDataDir } from '../support/testData.js';
import { forgetRoot } from '../../src/api/seal/forget.js';

const ROOT = testDataDir('sealForget');
const SECRET = 'SECRET-DIARY-LINE';
const author = { name: 'Ann', email: 'ann@example.invalid', timestamp: 1700000000, timezoneOffset: 360 };

describe('erasing a root entry from the Seal history', () => {
    let vault, dir, run = 0;

    const sys = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
    const commit = async (files, message) => {
        for (const [name, text] of Object.entries(files)) {
            const abs = path.join(dir, name);
            if (text === null) {
                fs.rmSync(abs);
                await git.remove({ fs, dir, filepath: name });
                continue;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, text);
            await git.add({ fs, dir, filepath: name });
        }
        return await git.commit({ fs, dir, message, author });
    };
    const messages = async () => (await git.log({ fs, dir })).map((c) => c.commit.message.trim());
    const everyObject = () => sys('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)').trim().split('\n')
        .filter(Boolean).map((line) => line.split(' '))
        .map(([oid, type]) => (type === 'tree' ? sys('ls-tree', oid) : sys('cat-file', '-p', oid))).join('\n');

    beforeEach(async () => {
        vault = path.join(ROOT, `v${run++}`);
        dir = path.join(vault, 'workspace');
        fs.rmSync(vault, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        await git.init({ fs, dir });
        await commit({ 'a.md': 'one' }, 'create: a.md');
        await commit({ '_diary/owner/2026-01-01.md': SECRET }, 'edit: _diary/owner/2026-01-01.md');
        await commit({ 'a.md': 'two' }, 'edit: a.md');
        await commit({ '_diary/owner/2026-01-01.md': `${SECRET} again`, 'b.md': 'b' }, 'reconcile: 2 files');
        await commit({ '_diary/owner/2026-01-01.md': null }, 'edit: _diary/owner/2026-01-01.md');
        await commit({ 'a.md': 'three' }, 'edit: a.md');
        fs.rmSync(path.join(dir, '_diary'), { recursive: true, force: true });
    });

    const assertErased = async () => {
        const objects = everyObject();
        assert.ok(!objects.includes(SECRET), 'no object holds the text');
        assert.ok(!objects.includes('_diary'), 'no tree or message names the folder');
        assert.deepEqual(await messages(), ['edit: a.md', 'reconcile: 2 files', 'edit: a.md', 'create: a.md']);
        assert.equal(sys('for-each-ref', 'refs/original'), '');
        sys('fsck', '--strict');
    };

    it('drops the entry and keeps every other commit, with its author and date', async () => {
        const tip = (await git.log({ fs, dir, depth: 1 }))[0].commit;
        assert.equal(await forgetRoot(dir, '_diary'), 3);
        await assertErased();

        const log = await git.log({ fs, dir });
        assert.equal(log[0].commit.tree, tip.tree, 'the newest version is the same');
        assert.deepEqual(log[0].commit.author, tip.author);
        assert.deepEqual((await git.statusMatrix({ fs, dir })).filter(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1), [], 'Seal sees no drift');
        assert.equal(await forgetRoot(dir, '_diary'), 0, 'a second run does nothing');

        await commit({ 'c.md': 'c' }, 'create: c.md');
        await git.checkout({ fs, dir, ref: log.at(-1).oid, force: true });
        assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf-8'), 'one', 'Seal can still commit and roll back');
    });

    it('erases packed objects too', async () => {
        sys('repack', '-a', '-d', '-q');
        sys('prune-packed', '-q');
        await forgetRoot(dir, '_diary');
        await assertErased();
    });

    it('works on the detached HEAD that a rollback leaves, and on every other branch', async () => {
        const tip = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        await git.checkout({ fs, dir, ref: tip, force: true });
        sys('branch', 'other', 'HEAD~2');
        sys('branch', 'before-the-diary', 'HEAD~5');
        await forgetRoot(dir, '_diary');
        assert.ok(!everyObject().includes(SECRET));
        assert.equal((await messages()).length, 4);
        sys('fsck', '--strict');
    });

    it('keeps the commits that no ref reaches, without the entry', async () => {
        const orphan = await commit({ '_diary/owner/2026-01-02.md': SECRET, 'lost.md': 'lost' }, 'reconcile: 2 files');
        await git.writeRef({ fs, dir, ref: 'refs/heads/master', value: (await git.readCommit({ fs, dir, oid: orphan })).commit.parent[0], force: true });
        fs.rmSync(path.join(dir, '_diary'), { recursive: true });
        await forgetRoot(dir, '_diary');
        const objects = everyObject();
        assert.ok(!objects.includes(SECRET));
        assert.ok(objects.includes('lost.md'), 'the rest of the orphan stays in the store');
    });

    it('finishes the work that a crash left, after the refs moved and before the old objects went', async () => {
        const old = path.join(vault, 'old.git');
        fs.cpSync(path.join(dir, '.git'), old, { recursive: true });
        await forgetRoot(dir, '_diary');
        fs.cpSync(path.join(old, 'objects'), path.join(dir, '.git', 'objects'), { recursive: true });
        assert.ok(everyObject().includes(SECRET), 'precondition: the old objects are back');
        await forgetRoot(dir, '_diary');
        await assertErased();
    });

    it('handles a history that starts with the entry, and one that holds nothing else', async () => {
        for (const rest of [{ 'a.md': 'one' }, null]) {
            fs.rmSync(vault, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            await git.init({ fs, dir });
            await commit({ '_diary/owner/2026-01-01.md': SECRET }, 'edit: _diary/owner/2026-01-01.md');
            if (rest) await commit(rest, 'create: a.md');
            await forgetRoot(dir, '_diary');
            assert.ok(!/SECRET|_diary/.test(everyObject()));
            if (rest) assert.deepEqual(await messages(), ['create: a.md']);
            await commit({ 'z.md': 'z' }, 'create: z.md');
            assert.equal((await messages())[0], 'create: z.md', 'Seal can still commit');
        }
    });
});
