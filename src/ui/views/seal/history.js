import { parseCommitMessage, describeCommit, describeTarget, documentPath, dirName, baseName } from './describe.js';

export const titleOf = (name) => (String(name).endsWith('/') ? String(name).slice(0, -1) : String(name).replace(/\.[^./]+$/, ''));

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

export const dayOf = (commit) => {
    const d = new Date((commit.commit.author?.timestamp ?? 0) * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

export function runHolding(log, oid, tr) {
    for (const { commits } of byDay(log)) {
        const run = foldRuns(commits, tr).find((g) => g.kind === 'run' && g.commits.some((c) => c.oid === oid));
        if (run) return run.key;
    }
    return null;
}

export const driftCount = (drift) => (drift ? drift.added.length + drift.modified.length + drift.deleted.length : 0);
