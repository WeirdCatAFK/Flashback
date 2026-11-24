import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import * as Files from '../resources/files.js';
import * as categoryRows from '../resources/db/categories.js';
import * as documentRows from '../resources/db/documents.js';
import * as flashcardRows from '../resources/db/flashcards.js';
import * as folderRows from '../resources/db/folders.js';
import * as linkRows from '../resources/db/links.js';
import * as mediaRows from '../resources/db/media.js';
import * as tagRows from '../resources/db/tags.js';
import * as vaultRows from '../resources/db/vault.js';
import * as Documents from './documents.js';
import * as Decks from './decks.js';
import { sealEmitter, sealTools } from '../../seal/seal.js';
import { OWNER_SCOPE } from '../../requestContext.js';

const norm = p => (p ?? '').split(/[\\/]+/).filter(Boolean).join('/');
const depth = p => norm(p).split('/').length;

export async function checkIndex() {
    await sealEmitter.flushEdits();

    const integrity = await vaultRows.integrityCheck();
    const walk = Files.walkWorkspace();
    const dbDocs = await documentRows.getAll();
    const dbFolders = await folderRows.getAll();

    const walkFolderByPath = new Map(walk.folders.map(f => [norm(f.relPath), f]));
    const dbFolderPaths = new Set(dbFolders.map(f => norm(f.relative_path)).filter(p => p !== ''));

    const folders = {
        missingInDb: walk.folders.filter(f => !f.sidecarCorrupt && !dbFolderPaths.has(norm(f.relPath))).map(f => f.relPath),
        orphanedInDb: dbFolders
            .filter(f => norm(f.relative_path) !== '' && !walkFolderByPath.has(norm(f.relative_path)))
            .map(f => f.relative_path),
        ghostDirs: walk.folders.filter(f => !f.sidecarExists).map(f => f.relPath),
        corruptSidecars: walk.folders.filter(f => f.sidecarCorrupt).map(f => f.relPath),
    };

    const walkDocByPath = new Map(await walk.documents.map(d => [norm(d.relPath), d]));
    const dbDocByPath = new Map(dbDocs.map(d => [norm(d.relative_path), d]));

    const missingInDb = [];
    const modified = [];
    const corruptDocSidecars = [];
    const hashOwners = new Map();

    for (const wd of walk.documents) {
        if (wd.sidecarCorrupt) { corruptDocSidecars.push(wd.relPath); continue; }
        const hash = wd.meta?.globalHash;
        if (hash) {
            if (!hashOwners.has(hash)) hashOwners.set(hash, []);
            hashOwners.get(hash).push(wd.relPath);
        }

        const dbDoc = dbDocByPath.get(norm(wd.relPath));
        if (!dbDoc) { missingInDb.push(wd.relPath); continue; }

        const reasons = await _diffDocument(wd.meta ?? {}, dbDoc);
        if (reasons.length > 0) modified.push({ relPath: wd.relPath, reasons });
    }

    const hashConflicts = [...hashOwners.entries()]
        .filter(([, paths]) => paths.length > 1)
        .map(([hash, paths]) => ({ hash, paths }));

    const documents = {
        missingInDb,
        orphanedInDb: dbDocs
            .filter(d => !walkDocByPath.has(norm(d.relative_path)))
            .map(d => d.relative_path),
        modified,
        hashConflicts,
        corruptSidecars: corruptDocSidecars,
        untracked: walk.strayItems,
    };

    const dbMedia = await mediaRows.getAll();
    const missingOnDisk = dbMedia.filter(m => !fs.existsSync(m.absolute_path)).map(m => m.relative_path);
    const dbMediaAbs = new Set(dbMedia.map(m => norm(m.absolute_path)));
    const unregistered = [];
    for (const dirRel of walk.mediaDirs) {
        const absDir = Files.safePath(dirRel);
        for (const name of fs.readdirSync(absDir)) {
            const abs = path.join(absDir, name);
            if (fs.lstatSync(abs).isFile() && !dbMediaAbs.has(norm(abs))) {
                unregistered.push(path.join(dirRel, name));
            }
        }
    }

    return {
        db: { integrity },
        folders,
        documents,
        media: { missingOnDisk, unregistered },
        decks: await Decks.diagnoseDecks(),
        seal: { drift: await sealTools.inspect() },
        counts: {
            documents: dbDocs.length,
            folders: Math.max(0, dbFolders.length - 1),
            flashcards: await flashcardRows.getCount(),
            standaloneCards: await flashcardRows.getStandaloneCount(),
            pendingLinks: await linkRows.getPendingCount(),
        },
        generatedAt: new Date().toISOString(),
    };
}

async function _diffDocument(meta, dbDoc) {
    const reasons = [];
    if (meta.globalHash && meta.globalHash !== dbDoc.global_hash) reasons.push('hashChanged');

    const dbCards = await flashcardRows.getByDocument(dbDoc.id, OWNER_SCOPE);
    const dbByHash = new Map(dbCards.map(c => [c.global_hash, c]));
    const metaCards = Array.isArray(meta.flashcards) ? meta.flashcards : [];

    const metaHashes = new Set(metaCards.map(c => c.globalHash).filter(Boolean));
    if (metaHashes.size !== dbByHash.size || [...metaHashes].some(h => !dbByHash.has(h))) {
        reasons.push('cardSetChanged');
    }

    const dbTags = new Set(await tagRows.getDirectNames(dbDoc.node_id));
    const metaTags = new Set(meta.tags ?? []);
    if (dbTags.size !== metaTags.size || [...metaTags].some(t => !dbTags.has(t))) {
        reasons.push('tagsChanged');
    }
    return reasons;
}

export async function syncIndex({ sealDrift = true } = {}) {
    const report = await checkIndex();
    if (report.db.integrity !== 'ok') {
        throw new Error(`Database integrity check failed (${report.db.integrity}). Sync cannot proceed — rebuild the index from files instead.`);
    }

    const actions = {
        foldersIndexed: 0, documentsIndexed: 0, documentsReindexed: 0,
        foldersRemoved: 0, documentsRemoved: 0,
        mediaRowsRemoved: 0, mediaRegistered: 0,
        decks: null,
    };
    const warnings = [];
    const conflictPaths = new Set(report.documents.hashConflicts.flatMap(c => c.paths.map(norm)));

    for (const relPath of [...report.folders.missingInDb].sort((a, b) => depth(a) - depth(b))) {
        try {
            await Documents.indexFolder(relPath);
            actions.foldersIndexed++;
        } catch (err) {
            warnings.push(`Folder indexing failed for ${relPath}: ${err.message}`);
        }
    }

    for (const relPath of report.documents.missingInDb) {
        if (conflictPaths.has(norm(relPath))) continue;
        try {
            await Documents.indexDocument(relPath);
            actions.documentsIndexed++;
        } catch (err) {
            warnings.push(`Document indexing failed for ${relPath}: ${err.message}`);
        }
    }

    for (const { relPath } of report.documents.modified) {
        if (conflictPaths.has(norm(relPath))) continue;
        try {
            await Documents.reindexDocument(relPath);
            actions.documentsReindexed++;
        } catch (err) {
            warnings.push(`Document reindex failed for ${relPath}: ${err.message}`);
        }
    }

    for (const relPath of [...report.folders.orphanedInDb].sort((a, b) => depth(a) - depth(b))) {
        try {
            await Documents.removeFromIndex(relPath, true);
            actions.foldersRemoved++;
        } catch (err) {
            warnings.push(`Folder removal failed for ${relPath}: ${err.message}`);
        }
    }
    for (const relPath of report.documents.orphanedInDb) {
        try {
            if (await documentRows.getByPath(relPath)) {
                await Documents.removeFromIndex(relPath, false);
                actions.documentsRemoved++;
            }
        } catch (err) {
            warnings.push(`Document removal failed for ${relPath}: ${err.message}`);
        }
    }

    for (const relPath of report.media.missingOnDisk) {
        await mediaRows.deleteByAbsPath(Files.safePath(relPath));
        actions.mediaRowsRemoved++;
    }
    for (const relPath of report.media.unregistered) {
        try {
            await _registerMediaFile(relPath);
            actions.mediaRegistered++;
        } catch (err) {
            warnings.push(`Media registration failed for ${relPath}: ${err.message}`);
        }
    }

    actions.decks = await Decks.repairFromFiles();

    const sealedOid = sealDrift ? await sealTools.commitDrift() : null;

    return {
        actions,
        skipped: {
            hashConflicts: report.documents.hashConflicts,
            corruptSidecars: [...report.documents.corruptSidecars, ...report.folders.corruptSidecars],
            untracked: report.documents.untracked,
            danglingDeckEntries: report.decks.danglingEntries,
        },
        warnings,
        sealedOid,
        report,
    };
}

export async function rebuildIndex() {
    await sealEmitter.flushEdits();
    const walk = Files.walkWorkspace();
    const warnings = [];

    await _ensureCategories(walk, warnings);

    await vaultRows.wipeDerivedContent();

    await Documents.indexFolder('');
    let foldersIndexed = 0;
    for (const f of walk.folders) {
        try {
            await Documents.indexFolder(f.relPath);
            foldersIndexed++;
        } catch (err) {
            warnings.push(`Folder indexing failed for ${f.relPath}: ${err.message}`);
        }
    }

    let documentsIndexed = 0;
    for (const d of walk.documents) {
        if (d.sidecarCorrupt) {
            warnings.push(`Corrupt sidecar skipped: ${d.relPath}`);
            continue;
        }
        try {
            await Documents.indexDocument(d.relPath);
            documentsIndexed++;
        } catch (err) {
            warnings.push(`Document indexing failed for ${d.relPath}: ${err.message}`);
        }
    }

    await Documents.indexFolder('');

    const deckResult = await Decks.rebuildFromFiles();
    warnings.push(...deckResult.warnings);

    let mediaRegistered = 0;
    for (const dirRel of walk.mediaDirs) {
        const absDir = Files.safePath(dirRel);
        for (const name of fs.readdirSync(absDir)) {
            if (!fs.lstatSync(path.join(absDir, name)).isFile()) continue;
            try {
                await _registerMediaFile(path.join(dirRel, name));
                mediaRegistered++;
            } catch (err) {
                warnings.push(`Media registration failed for ${path.join(dirRel, name)}: ${err.message}`);
            }
        }
    }

    return {
        summary: {
            foldersIndexed,
            documentsIndexed,
            flashcards: await flashcardRows.getCount(),
            decks: deckResult.decks,
            standaloneCardsRestored: deckResult.restoredCards,
            mediaRegistered,
        },
        warnings,
    };
}

async function _ensureCategories(walk, warnings) {
    const wanted = new Set();
    for (const d of walk.documents) {
        for (const fc of d.meta?.flashcards ?? []) {
            if (fc.category) wanted.add(fc.category);
        }
    }
    for (const f of await Decks.listDeckFiles()) {
        for (const e of f.data?.entries ?? []) {
            if (e.card?.category) wanted.add(e.card.category);
        }
    }
    for (const name of wanted) {
        if (!await categoryRows.getByName(name)) {
            try {
                await categoryRows.insert({ name, priority: 1, description: 'Recovered by Vault Doctor' });
            } catch (err) {
                warnings.push(`Could not recreate category "${name}": ${err.message}`);
            }
        }
    }
}

async function _registerMediaFile(relPath) {
    const abs = Files.safePath(relPath);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    await mediaRows.insert({
        hash,
        name: path.basename(relPath),
        relativePath: relPath,
        absolutePath: abs,
    });
}
