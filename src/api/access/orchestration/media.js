import Files from '../resources/files.js';
import query from '../resources/query.js';
import db from '../primitives/database.js';
import { sealEmitter } from '../../seal/seal.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export default class Media {
    constructor() {
        this.files = new Files();
        this.query = query;
    }

    async serve(hash) {
        const entry = await this.query.getMediaByHash(hash);
        if (!entry) throw new Error(`Media not found: ${hash}`);
        if (!fs.existsSync(entry.absolute_path)) {
            throw new Error(`Media file missing on disk: ${entry.absolute_path}`);
        }
        return entry;
    }

    serveByPath(relDocPath, name) {
        const mediaRel = path.join(path.dirname(relDocPath), 'media', path.basename(name));
        const absolutePath = this.files.safePath(mediaRel);
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`Media file not found: ${mediaRel}`);
        }
        return absolutePath;
    }

    async list(folderRelPath) {
        const absDir = this.files.safePath(path.join(folderRelPath, 'media'));
        if (!fs.existsSync(absDir)) return [];

        const prefix = absDir + path.sep;
        const dbEntries = await this.query.getMediaByAbsPathPrefix(prefix);
        const byAbsPath = new Map(dbEntries.map(e => [e.absolute_path, e]));

        return await fs.readdirSync(absDir).map(name => {
            const absolutePath = path.join(absDir, name);
            const relativePath = path.join(folderRelPath, 'media', name);
            const entry = byAbsPath.get(absolutePath);
            return { name, relativePath, absolutePath, hash: entry?.hash ?? null };
        });
    }

    async addVanillaMedia(relDocPath, flashcardHash, buffer, name, type, position) {
        const meta = this.files.getMetadata(relDocPath);
        const cardIdx = meta?.flashcards?.findIndex(f => f.globalHash === flashcardHash) ?? -1;
        if (cardIdx === -1) throw new Error(`Flashcard ${flashcardHash} not found in ${relDocPath}`);

        this.files.addVanillaData(relDocPath, buffer, name, type, position, cardIdx);

        const mediaRel = path.join(path.dirname(relDocPath), 'media', name);
        const mediaAbs = this.files.safePath(mediaRel);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');

        await db.transaction(async () => {
            await this.query.insertMedia({ hash, name, relativePath: mediaRel, absolutePath: mediaAbs });
        })();

        await sealEmitter.edit(relDocPath + '.flashback', [mediaRel]);
    }

    async removeMedia(relDocPath, mediaName) {
        const mediaRel = path.join(path.dirname(relDocPath), 'media', mediaName);
        const mediaAbs = this.files.safePath(mediaRel);

        this.files.removeCustomMedia(relDocPath, mediaName);

        await db.transaction(async () => {
            await this.query.deleteMediaByAbsPath(mediaAbs);
        })();

        await sealEmitter.edit(relDocPath + '.flashback', []);
    }

    async reconcile(folderRelPath) {
        const absDir = this.files.safePath(path.join(folderRelPath, 'media'));
        const prefix = absDir + path.sep;
        const entries = await this.query.getMediaByAbsPathPrefix(prefix);
        const orphans = entries.filter(e => !fs.existsSync(e.absolute_path));

        await db.transaction(async () => {
            for (const orphan of orphans) {
                await this.query.deleteMediaByAbsPath(orphan.absolute_path);
            }
        })();

        return orphans;
    }
}
