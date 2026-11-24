/**
 * Erases _diary/ from a vault's Seal history. An older build committed diary entries there.
 * It needs the git command. The app must be closed, because Seal writes to the same repository.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export function scrubDiary(vaultDir) {
    const workspace = path.join(vaultDir, 'workspace');
    const gitDir = path.join(workspace, '.git');
    if (!fs.existsSync(gitDir)) throw new Error(`No Seal history in ${vaultDir}. Pass the vault folder itself.`);
    if (fs.existsSync(path.join(workspace, '_diary'))) {
        throw new Error('The workspace still holds _diary/. Open the vault once in Flashback, which moves the entries, then close it and run this again.');
    }

    const git = (...args) => execFileSync('git', ['--git-dir', gitDir, ...args], {
        encoding: 'utf-8',
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: Infinity,
        env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
    }).trim();
    const lines = (text) => (text ? text.split('\n') : []);
    const touching = () => lines(git('log', '--all', 'HEAD', '--full-history', '--topo-order', '--format=%H', '--', '_diary'));

    const commits = touching();
    if (commits.length === 0) return { commits: 0, backup: null };

    const doomed = new Set([...commits, ...commits.flatMap((oid) => lines(git('ls-tree', '-r', '-t', '--format=%(objectname)', oid, '_diary')))]);
    const parentsOfFirst = lines(git('rev-parse', `${commits.at(-1)}^@`));
    const backup = path.join(vaultDir, `seal-backup-${Date.now()}.git`);
    fs.cpSync(gitDir, backup, { recursive: true });

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-scrub-'));
    git('config', 'core.bare', 'true');
    try {
        git('filter-branch', '-d', path.join(scratch, 'rewrite'), '--prune-empty',
            '--index-filter', 'git rm -r --cached --ignore-unmatch -q -- _diary', '--', '--all', 'HEAD', ...parentsOfFirst.map((oid) => `^${oid}`));
    } finally {
        git('config', 'core.bare', 'false');
        fs.rmSync(scratch, { recursive: true, force: true });
    }

    for (const ref of lines(git('for-each-ref', '--format=%(refname)', 'refs/original'))) git('update-ref', '-d', ref);
    fs.rmSync(path.join(gitDir, 'ORIG_HEAD'), { force: true });
    git('reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
    git('prune', '--expire=now');
    const packed = lines(git('cat-file', '--batch-all-objects', '--batch-check=%(objectname)')).some((oid) => doomed.has(oid));
    if (packed) git('repack', '-a', '-d', '-q');

    if (touching().length) throw new Error(`Part of the history still holds _diary. The untouched history is in ${backup}.`);
    return { commits: commits.length, backup };
}
