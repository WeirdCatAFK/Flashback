import * as Files from '../resources/files.js';
import * as mediaRows from '../resources/db/media.js';
import db from '../primitives/database.js';
import { sealEmitter } from '../../seal/seal.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export async function serve(hash) {
    const entry = await mediaRows.getByHash(hash);
    if (!entry) throw new Error(`Media not found: ${hash}`);
    if (!fs.existsSync(entry.absolute_path)) {
        throw new Error(`Media file missing on disk: ${entry.absolute_path}`);
    }
    return entry;
}

export function serveByPath(relDocPath, name) {
    const mediaRel = path.join(path.dirname(relDocPath), 'media', path.basename(name));
    const absolutePath = Files.safePath(mediaRel);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Media file not found: ${mediaRel}`);
    }
    return absolutePath;
}

export async function list(folderRelPath) {
    const absDir = Files.safePath(path.join(folderRelPath, 'media'));
    if (!fs.existsSync(absDir)) return [];

    const prefix = absDir + path.sep;
    const dbEntries = await mediaRows.getByAbsPathPrefix(prefix);
    const byAbsPath = new Map(dbEntries.map(e => [e.absolute_path, e]));

    return await fs.readdirSync(absDir).map(name => {
        const absolutePath = path.join(absDir, name);
        const relativePath = path.join(folderRelPath, 'media', name);
        const entry = byAbsPath.get(absolutePath);
        return { name, relativePath, absolutePath, hash: entry?.hash ?? null };
    });
}

export async function addVanillaMedia(relDocPath, flashcardHash, buffer, name, type, position) {
    const meta = Files.getMetadata(relDocPath);
    const cardIdx = meta?.flashcards?.findIndex(f => f.globalHash === flashcardHash) ?? -1;
    if (cardIdx === -1) throw new Error(`Flashcard ${flashcardHash} not found in ${relDocPath}`);

    Files.addVanillaData(relDocPath, buffer, name, type, position, cardIdx);

    const mediaRel = path.join(path.dirname(relDocPath), 'media', name);
    const mediaAbs = Files.safePath(mediaRel);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    await db.transaction(async () => {
        await mediaRows.insert({ hash, name, relativePath: mediaRel, absolutePath: mediaAbs });
    })();

    await sealEmitter.edit(relDocPath + '.flashback', [mediaRel]);
}

export async function removeMedia(relDocPath, mediaName) {
    const mediaRel = path.join(path.dirname(relDocPath), 'media', mediaName);
    const mediaAbs = Files.safePath(mediaRel);

    Files.removeCustomMedia(relDocPath, mediaName);

    await db.transaction(async () => {
        await mediaRows.deleteByAbsPath(mediaAbs);
    })();

    await sealEmitter.edit(relDocPath + '.flashback', []);
}

export async function reconcile(folderRelPath) {
    const absDir = Files.safePath(path.join(folderRelPath, 'media'));
    const prefix = absDir + path.sep;
    const entries = await mediaRows.getByAbsPathPrefix(prefix);
    const orphans = entries.filter(e => !fs.existsSync(e.absolute_path));

    await db.transaction(async () => {
        for (const orphan of orphans) {
            await mediaRows.deleteByAbsPath(orphan.absolute_path);
        }
    })();

    return orphans;
}
