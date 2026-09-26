/**
 * The History tab's shaping, as plain functions: each commit as the parts of one sentence
 * (what happened, to what, where), the log split into days, and consecutive metadata edits
 * to one document folded into a single run. `tr` is `{ t, tp }`, as in describe.js.
 *
 * A metadata run is what a reading session produces: every highlight and card is its own
 * seal, so twenty of them on one book would bury everything else. Only consecutive
 * metadata seals on the same target by the same author fold; anything between them breaks
 * the run, so the order of events stays readable.
 */

import { parseCommitMessage, describeCommit, describeTarget, documentPath, dirName, baseName } from './describe.js';

/** A document's name as the tree shows it: no extension. Folders (trailing /) keep theirs. */
export const titleOf = (name) => (String(name).endsWith('/') ? String(name).slice(0, -1) : String(name).replace(/\.[^./]+$/, ''));

/**
 * One commit as a sentence's parts: `{ kind, name, dir, from }`. `kind` picks the sentence:
 * `folder` (created one), `deck`, `added` (a document), `text` (its text edited),
 * `metadata` (highlights, cards or tags), `renamed` (a move within its folder, `from` the
 * old name), `moved` (`from` the old folder, '' for the top level), `deleted`, `reconcile`,
 * or `other` (`name` the raw message).
 */
export function sealLine(commit, tr) {
    const { action, detail } = parseCommitMessage(commit.commit.message);
    if (action === 'move') {
        const raw = commit.commit.message.slice(commit.commit.message.indexOf(': ') + 2).replace(/\\/g, '/');
        const [src, dest] = raw.split(' -> ');
        if (!dest) return { kind: 'other', name: commit.commit.message, dir: '', from: '' };
        const to = documentPath(dest);
        const was = documentPath(src);
        const dir = dirName(to);
        if (dirName(was) === dir) return { kind: 'renamed', name: titleOf(baseName(to)), dir, from: titleOf(baseName(was)) };
        return { kind: 'moved', name: titleOf(baseName(to)), dir, from: dirName(was) };
    }
    const target = describeTarget(detail, tr);
    const name = target?.name ?? detail;
    const dir = target?.dir ?? '';
    if (action === 'create') {
        if (detail.replace(/\\/g, '/').startsWith('_decks/')) return { kind: 'deck', name, dir, from: '' };
        if (name.endsWith('/')) return { kind: 'folder', name: titleOf(name), dir, from: '' };
        return { kind: 'added', name: titleOf(name), dir, from: '' };
    }
    if (action === 'edit') {
        const metadata = describeCommit(commit, tr).variant === 'metadata';
        return { kind: metadata ? 'metadata' : 'text', name: titleOf(name), dir, from: '' };
    }
    if (action === 'delete') return { kind: 'deleted', name: titleOf(name), dir, from: '' };
    if (action === 'reconcile') return { kind: 'reconcile', name, dir, from: '' };
    return { kind: 'other', name: commit.commit.message, dir: '', from: '' };
}

const pad = (n) => String(n).padStart(2, '0');

/** A commit's local calendar day, `YYYY-MM-DD`. Commit timestamps are unix seconds. */
export const dayOf = (commit) => {
    const d = new Date((commit.commit.author?.timestamp ?? 0) * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The log (newest first) as days, newest first: `[{ day, commits }]`. */
export function byDay(log) {
    const days = [];
    for (const commit of log) {
        const day = dayOf(commit);
        const last = days[days.length - 1];
        if (last?.day === day) last.commits.push(commit);
        else days.push({ day, commits: [commit] });
    }
    return days;
}

/**
 * A day's commits with consecutive metadata edits folded: `{ kind: 'one', commit }` or
 * `{ kind: 'run', key, commits }` (two or more, newest first; `key` the newest oid).
 * Consecutive means same target and same author email, nothing else in between.
 */
export function foldRuns(commits, tr) {
    const out = [];
    for (const commit of commits) {
        const line = sealLine(commit, tr);
        const target = parseCommitMessage(commit.commit.message).detail;
        const who = commit.commit.author?.email ?? '';
        const last = out[out.length - 1];
        if (line.kind === 'metadata' && last?.metadata && last.target === target && last.who === who) {
            last.commits.push(commit);
            continue;
        }
        out.push({ metadata: line.kind === 'metadata', target, who, commits: [commit] });
    }
    return out.map((g) => (g.commits.length > 1
        ? { kind: 'run', key: g.commits[0].oid, commits: g.commits }
        : { kind: 'one', commit: g.commits[0] }));
}

/** The run that holds `oid`, for the ribbon to open before it scrolls there; null when it is not folded. */
export function runHolding(log, oid, tr) {
    for (const { commits } of byDay(log)) {
        const run = foldRuns(commits, tr).find((g) => g.kind === 'run' && g.commits.some((c) => c.oid === oid));
        if (run) return run.key;
    }
    return null;
}

/** How many files changed outside Flashback, from an inspect result. */
export const driftCount = (drift) => (drift ? drift.added.length + drift.modified.length + drift.deleted.length : 0);
