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

export function formatCommitTime(unixSeconds, { formatRelative, formatDateTime }) {
    if (!unixSeconds) return { relative: '', absolute: '' };
    const ms = unixSeconds * 1000;
    return { relative: formatRelative(ms), absolute: formatDateTime(ms) };
}

export const LIST_VISIBLE_CAP = 12;
