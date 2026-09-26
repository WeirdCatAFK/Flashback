/**
 * Turning seal commits into rows a person can read. Seal labels a commit with the
 * raw path it staged (a document's sidecar, a folder's `.flashback`, a deck file),
 * which means nothing to someone who has never opened a sidecar; these translate
 * each back into the thing that was touched. `tr` is `{ t, tp }` passed in so the
 * helpers stay plain functions.
 */

export const SIDECAR_SUFFIX = '.flashback';

export function parseCommitMessage(message) {
    const idx = message.indexOf(': ');
    if (idx === -1) return { action: 'unknown', detail: message };
    const action = message.slice(0, idx);
    const rest = message.slice(idx + 2);
    if (action === 'move') {
        const [from, to] = rest.split(' -> ');
        return { action, detail: to ? `${from} → ${to}` : rest };
    }
    return { action, detail: rest };
}

export const baseName = p => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
export const dirName = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const isSidecar = p => p.endsWith(SIDECAR_SUFFIX);
export const documentPath = p => (isSidecar(p) ? p.slice(0, -SIDECAR_SUFFIX.length) : p);

/**
 * Seal labels commits with the raw path it staged: `notes/Chapter 1.md.flashback` for a
 * document, `notes/.flashback` for a folder, `_decks/<uuid>.json` for a deck. None of that
 * is meaningful to someone who has never opened a sidecar, so every label is translated
 * back into the thing the user actually touched. Returns null when the label isn't a path
 * (batch commits say "3 sidecars" / "12 files").
 *
 * `tr` is the { t, tp } pair from useT(), passed in rather than looked up: keeping these
 * helpers plain functions means the caller decides when they run, and they stay callable
 * from anywhere in the render tree without becoming hooks themselves.
 */
export function describeTarget(raw, tr) {
    if (!raw) return null;
    const p = raw.replace(/\\/g, '/');

    if (/^\d+ sidecars$/.test(p)) {
        const n = parseInt(p, 10);
        return { name: tr.tp('{n} document', '{n} documents', n), dir: '' };
    }
    if (/^\d+ files$/.test(p)) {
        const n = parseInt(p, 10);
        return { name: tr.tp('{n} file', '{n} files', n), dir: '' };
    }
    if (p.startsWith('_decks/')) return { name: tr.t('a deck'), dir: '' };

    if (p === SIDECAR_SUFFIX) return { name: tr.t('the workspace'), dir: '' };
    if (p.endsWith(`/${SIDECAR_SUFFIX}`)) {
        const folder = p.slice(0, -(SIDECAR_SUFFIX.length + 1));
        return { name: `${baseName(folder)}/`, dir: dirName(folder) };
    }

    const doc = documentPath(p);
    return { name: baseName(doc), dir: dirName(doc) };
}

/**
 * Turns a commit into the row the timeline actually renders.
 *
 * The important case is `variant: 'metadata'` — an edit whose diff touched sidecars only.
 * That's what a highlight, a new flashcard, or a tag change looks like from git's side, and
 * it's the bulk of a normal session's history. Without this it reads as "Edited
 * chapter.md.flashback", which tells the user neither what changed nor why a file they
 * never opened is in their history. stats.content is the server-computed count of changed
 * non-sidecar paths, so this is measured, not inferred from the message.
 */
export function describeCommit(commit, tr) {
    const { action, detail } = parseCommitMessage(commit.commit.message);
    const stats = commit.stats;
    const touched = stats ? stats.added + stats.modified + stats.deleted : 0;
    const metadataOnly = action === 'edit' && stats && touched > 0 && stats.content === 0;
    const target = action === 'move' ? null : describeTarget(detail, tr);

    if (metadataOnly) {
        return {
            variant: 'metadata',
            detail: tr.t('Metadata updated for {target}', { target: target?.name ?? detail }),
            dir: target?.dir ?? '',
            raw: detail,
        };
    }
    return {
        variant: action,
        detail: target?.name ?? detail,
        dir: target?.dir ?? '',
        raw: detail,
    };
}

export function formatOid(oid) {
    return oid ? oid.slice(0, 7) : '';
}

/** isomorphic-git commit timestamps are unix seconds, not ms. */
export function formatCommitTime(unixSeconds, { formatRelative, formatDateTime }) {
    if (!unixSeconds) return { relative: '', absolute: '' };
    const ms = unixSeconds * 1000;
    return { relative: formatRelative(ms), absolute: formatDateTime(ms) };
}

/** How many paths a list shows before folding the rest behind a count. */
export const LIST_VISIBLE_CAP = 12;
