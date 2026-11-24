import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import * as git from 'isomorphic-git';
import { testDataDir } from '../support/testData.js';
import { scrubDiary } from '../../scripts/vaultScrub.js';

const ROOT = testDataDir('vaultScrub');
const SECRET = 'SECRET-DIARY-LINE';
const author = { name: 'Ann', email: 'ann@example.invalid', timestamp: 1700000000, timezoneOffset: 360 };

describe('erasing the diary from the Seal history', () => {
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
        .map((line) => line.split(' '))
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

    it('drops the diary, keeps every other commit and leaves a full backup outside the workspace', async () => {
        const tip = (await git.log({ fs, dir, depth: 1 }))[0].commit;
        const { commits, backup } = scrubDiary(vault);
        assert.equal(commits, 3);
        await assertErased();

        const log = await git.log({ fs, dir });
        assert.equal(log[0].commit.tree, tip.tree, 'the newest version is the same');
        assert.deepEqual(log[0].commit.author, tip.author);
        assert.deepEqual((await git.statusMatrix({ fs, dir })).filter(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1), [], 'Seal sees no drift');

        assert.equal(path.dirname(backup), vault);
        const kept = execFileSync('git', ['--git-dir', backup, 'log', '--format=%s'], { encoding: 'utf-8' });
        assert.equal(kept.trim().split('\n').length, 6);

        assert.deepEqual(scrubDiary(vault), { commits: 0, backup: null }, 'a second run does nothing');
        assert.equal(fs.readdirSync(vault).length, 2, 'and makes no second backup');

        await commit({ 'c.md': 'c' }, 'create: c.md');
        await git.checkout({ fs, dir, ref: log.at(-1).oid, force: true });
        assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf-8'), 'one', 'Seal can still commit and roll back');
    });

    it('erases packed objects too', async () => {
        sys('repack', '-a', '-d', '-q');
        sys('prune-packed', '-q');
        scrubDiary(vault);
        await assertErased();
    });

    it('works on the detached HEAD that a rollback leaves, and on every other branch', async () => {
        const tip = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        await git.checkout({ fs, dir, ref: tip, force: true });
        sys('branch', 'other', 'HEAD~2');
        sys('branch', 'before-the-diary', 'HEAD~5');
        scrubDiary(vault);
        assert.ok(!everyObject().includes(SECRET));
        assert.equal((await messages()).length, 4);
        sys('fsck', '--strict');
    });

    it('refuses while the entries are still files in the workspace', () => {
        fs.mkdirSync(path.join(dir, '_diary'));
        assert.throws(() => scrubDiary(vault), /Open the vault once/);
        assert.throws(() => scrubDiary(ROOT), /No Seal history/);
    });
});
