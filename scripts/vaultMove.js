/**
 * Moves a vault between installs as two zips. The shared zip holds the portable files and vault.json. The personal zip holds progress.db.
 * Both leave out Seal's .git and the derived index, which the import rebuilds.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';

const SCAFFOLDING = new Set(['.git', '_decks', '_categories.json']);

function addTree(zip, absDir, zipDir) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const abs = path.join(absDir, entry.name);
        const inZip = `${zipDir}/${entry.name}`;
        if (entry.isDirectory()) addTree(zip, abs, inZip);
        else if (entry.isFile() && !/\.tmp-\d+-\d+$/.test(entry.name)) zip.addLocalFile(abs, zipDir);
    }
}

/** SQLite's VACUUM INTO writes a consistent copy, even while a WAL file is beside the database. */
function snapshotDatabase(file) {
    const copy = path.join(os.tmpdir(), `flashback-progress-${process.pid}-${Date.now()}.db`);
    const db = new Database(file, { readonly: true });
    try {
        db.prepare('VACUUM INTO ?').run(copy);
    } finally {
        db.close();
    }
    return copy;
}

export const personalZipFor = (outFile) => outFile.replace(/(\.zip)?$/i, '-personal.zip');

export function exportVault(vaultDir, outFile) {
    const workspace = path.join(vaultDir, 'workspace');
    if (!fs.existsSync(workspace)) throw new Error(`No workspace/ in ${vaultDir}. Pass the vault folder itself.`);
    for (const old of [path.join(workspace, '_diary'), path.join(vaultDir, 'diary')]) {
        if (fs.existsSync(old)) throw new Error(`${old} still holds diary files from an older build. Open the vault once in Flashback, then export it.`);
    }

    const zip = new AdmZip();
    for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const abs = path.join(workspace, entry.name);
        if (entry.isDirectory()) addTree(zip, abs, `workspace/${entry.name}`);
        else if (entry.isFile()) zip.addLocalFile(abs, 'workspace');
    }

    const manifest = path.join(vaultDir, 'vault.json');
    if (fs.existsSync(manifest)) zip.addLocalFile(manifest);
    zip.writeZip(outFile);

    const progress = path.join(vaultDir, 'progress.db');
    const personalFile = fs.existsSync(progress) ? personalZipFor(outFile) : null;
    if (personalFile) {
        const snapshot = snapshotDatabase(progress);
        try {
            const personal = new AdmZip();
            personal.addLocalFile(snapshot, '', 'progress.db');
            personal.writeZip(personalFile);
        } finally {
            fs.rmSync(snapshot, { force: true });
        }
    }
    return { entries: zip.getEntries().length, outFile, personalFile };
}

function hasProgress(file) {
    if (!fs.existsSync(file)) return false;
    const db = new Database(file, { readonly: true });
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('CardProgress', 'ReviewLogs', 'ReadProgress', 'DiaryEntries')").all();
        return tables.some(({ name }) => db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get());
    } finally {
        db.close();
    }
}

/** Refuses a target that holds documents or progress. A server that started once holds only scaffolding: .git, the system deck, the default categories and an empty progress.db. */
export function assertEmptyTarget({ workspace, progress }) {
    const content = fs.existsSync(workspace)
        ? fs.readdirSync(workspace).filter((name) => !SCAFFOLDING.has(name))
        : [];
    if (content.length) throw new Error(`The target workspace already holds files (${content.slice(0, 3).join(', ')}). Import only into a new vault.`);
    if (hasProgress(progress)) throw new Error('The target progress.db already holds progress. Import only into a new vault.');
}

/** Extracts the zips from exportVault into the open config's vault, then rebuilds the index. The server must be stopped. */
export async function importVault(zipFile, personalFile = null) {
    const config = await import('../src/api/access/primitives/config.js');
    const workspace = config.getWorkspacePath();
    const progress = config.getProgressDatabasePath();
    assertEmptyTarget({ workspace, progress });

    const zip = new AdmZip(zipFile);
    const names = zip.getEntries().map((e) => e.entryName);
    if (!names.some((n) => n.startsWith('workspace/'))) throw new Error('This zip has no workspace/ folder. Make it with npm run vault:export.');
    const personal = personalFile && new AdmZip(personalFile).getEntry('progress.db');
    if (personalFile && !personal) throw new Error('The personal zip has no progress.db. Make it with npm run vault:export.');

    fs.mkdirSync(workspace, { recursive: true });
    for (const name of fs.readdirSync(workspace)) fs.rmSync(path.join(workspace, name), { recursive: true, force: true });
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.startsWith('workspace/')) continue;
        const target = path.resolve(workspace, entry.entryName.slice('workspace/'.length));
        if (!target.startsWith(path.resolve(workspace) + path.sep)) throw new Error(`Unsafe path in zip: ${entry.entryName}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
    }

    fs.mkdirSync(config.getVaultPath(), { recursive: true });
    if (personal) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${progress}${suffix}`, { force: true });
        fs.writeFileSync(progress, personal.getData());
    }
    if (names.includes('vault.json')) fs.writeFileSync(path.join(config.getVaultPath(), 'vault.json'), zip.getEntry('vault.json').getData());

    const { openVault, releaseVault } = await import('../src/api/vaultSession.js');
    if (!await openVault({ onFatal: (msg) => { throw new Error(msg); } })) throw new Error('The vault did not open after the import.');
    const Doctor = await import('../src/api/access/modules/doctor.js');
    const result = await Doctor.rebuildIndex();
    await releaseVault();
    return result;
}
