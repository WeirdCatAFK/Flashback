/**
 * The Vault Doctor report as rows: which paths are missing from, stale in, or
 * unknown to the index, and the tone each group takes. Pure; takes `t`.
 */

export function collectDoctorIssues(report, t) {
    const groups = [];
    const add = (label, tone, paths) => { if (paths && paths.length) groups.push({ label, tone, paths }); };
    const d = report.documents;
    const f = report.folders;
    const m = report.media;
    const dk = report.decks;

    add(t('Documents on disk, not indexed'), 'added', d.missingInDb);
    add(t('Index rows with no file'), 'deleted', d.orphanedInDb);
    add(t('Modified since last index'), 'modified', d.modified.map(x => `${x.relPath}  ·  ${x.reasons.join(', ')}`));
    add(t('Hash conflicts — skipped'), 'warn', d.hashConflicts.map(x => `${x.hash.slice(0, 8)}…  ·  ${x.paths.join('  ,  ')}`));
    add(t('Corrupt document sidecars'), 'warn', d.corruptSidecars);
    add(t('Stray files'), 'warn', d.untracked.map(x => `${x.relPath}  (${x.kind})`));

    add(t('Folders on disk, not indexed'), 'added', f.missingInDb);
    add(t('Folder rows with no directory'), 'deleted', f.orphanedInDb);
    add(t('Ghost directories — no sidecar'), 'warn', f.ghostDirs);
    add(t('Corrupt folder sidecars'), 'warn', f.corruptSidecars);

    add(t('Media files not registered'), 'added', m.unregistered);
    add(t('Media rows missing on disk'), 'deleted', m.missingOnDisk);

    add(t('Deck files not in index'), 'added', dk.fileWithoutDb);
    add(t('Deck rows with no file'), 'deleted', dk.dbWithoutFile);
    add(t('Corrupt deck files'), 'warn', dk.corruptFiles);
    add(t('Deck entry mismatches'), 'modified', dk.entryMismatches.map(x => `${x.deckHash.slice(0, 8)}…  ·  +${x.missingInDb.length} / −${x.missingInFile.length}`));
    add(t('Dangling deck entries'), 'warn', dk.danglingEntries.map(x => `${x.deckHash.slice(0, 8)}… → ${x.cardHash.slice(0, 8)}…`));

    return groups;
}

export const TONE_CLASS = {
    added: 'seal-loose-group-label--added',
    modified: 'seal-loose-group-label--modified',
    deleted: 'seal-loose-group-label--deleted',
    warn: 'seal-doctor-group-label--warn',
};
