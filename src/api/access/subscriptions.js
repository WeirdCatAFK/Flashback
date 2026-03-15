/**
 * Subscriptions.js
 * Manages magazine subscriptions, checks for updates, and handles the import and merging of new issues.
 */

import db from './database.js';
import Documents from './documents.js';
import AdmZip from 'adm-zip';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

export default class Subscriptions {
    constructor() {
        this.db = db;
        this.documents = new Documents();
    }

    /**
     * Subscribes the current user to a magazine.
     */
    subscribe(magazineId, userId) {
        console.log(`User ${userId} subscribing to magazine ${magazineId}`);
        // To be implemented: API call + DB entry
    }

    /**
     * Imports and merges a magazine issue into the user's local workspace.
     */
    async importIssue(magazineId, issueData, targetRelPath) {
        console.log(`Importing issue from ${magazineId} into ${targetRelPath}`);

        const tempRoot = path.join(os.tmpdir(), 'flashback_imports', crypto.randomUUID());
        const tempIssuePath = path.join(tempRoot, 'issue.zip');
        const processedPaths = new Set();

        try {
            // 1. Unpack
            await fs.mkdir(tempRoot, { recursive: true });
            await fs.writeFile(tempIssuePath, issueData);

            const zip = new AdmZip(tempIssuePath);
            const entry = zip.getEntries()[0];
            const issueFolderName = entry.entryName.split('/')[0];
            const importRootPath = path.join(tempRoot, issueFolderName);
            zip.extractAllTo(tempRoot, true);

            // 2. Read issue metadata (for version tracking)
            let issueMetadata = null;
            try {
                const rootMetaPath = path.join(importRootPath, '.flashback');
                issueMetadata = JSON.parse(await fs.readFile(rootMetaPath, 'utf-8'));
            } catch (e) {}

            // 3. Crawler
            const crawl = async (currentPath, destRelPath) => {
                const entries = await fs.readdir(currentPath, { withFileTypes: true });

                for (const entry of entries) {
                    const srcPath = path.join(currentPath, entry.name);
                    const entryRelPath = path.join(destRelPath, entry.name);

                    if (entry.name === '.flashback' || entry.name.endsWith('.flashback')) continue;

                    if (entry.isDirectory()) {
                        const metaPath = path.join(srcPath, '.flashback');
                        const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

                        const existingFolder = this.documents.query.getFolderByHash(metadata.globalHash) 
                                            || this.documents.query.getFolderByPath(entryRelPath);

                        if (existingFolder) {
                            await this.documents.updateMetadata(existingFolder.relative_path, metadata, true);
                            processedPaths.add(existingFolder.absolute_path);
                        } else {
                            await this.documents.createFolder(entry.name, destRelPath);
                            await this.documents.updateMetadata(entryRelPath, metadata, true);
                            const newFolder = this.documents.query.getFolderByPath(entryRelPath);
                            if (newFolder) processedPaths.add(newFolder.absolute_path);
                        }
                        await crawl(srcPath, entryRelPath);
                    } else {
                        const metaPath = srcPath + '.flashback';
                        const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
                        const content = await fs.readFile(srcPath, 'utf-8');

                        const existingDoc = this.documents.query.getDocumentByHash(metadata.globalHash)
                                         || this.documents.query.getDocumentByPath(entryRelPath);

                        if (existingDoc) {
                            await this.documents.updateFile(existingDoc.relative_path, content, metadata);
                            processedPaths.add(existingDoc.absolute_path);
                        } else {
                            await this.documents.createFile(entry.name, destRelPath);
                            await this.documents.updateFile(entryRelPath, content, metadata);
                            const newDoc = this.documents.query.getDocumentByPath(entryRelPath);
                            if (newDoc) processedPaths.add(newDoc.absolute_path);
                        }
                    }
                }
            };

            await crawl(importRootPath, targetRelPath);

            // 4. Update Subscriptions table & Root Metadata
            if (issueMetadata && issueMetadata.subscription) {
                const sub = issueMetadata.subscription;
                this.db.transaction(() => {
                    this.documents.query.upsertSubscription({
                        magazineId: sub.magazineId,
                        issueId: sub.issueId,
                        version: sub.version,
                        targetPath: targetRelPath
                    });
                })();

                const targetMeta = this.documents.metadata.getMetadata(targetRelPath, true) || {};
                targetMeta.subscription = sub;
                this.documents.metadata.writeMetadata(targetRelPath, targetMeta, true);
            }

            // 5. 2Deletion of removed content
            const targetFolder = this.documents.query.getFolderByPath(targetRelPath);
            if (targetFolder) {
                const prefix = targetFolder.absolute_path + path.sep;
                const existingDocs = this.db.prepare('SELECT absolute_path, relative_path FROM Documents WHERE absolute_path LIKE ? || \'%\'').all(prefix);
                const existingFolders = this.db.prepare('SELECT absolute_path, relative_path FROM Folders WHERE absolute_path LIKE ? || \'%\' AND absolute_path != ?').all(prefix, targetFolder.absolute_path);

                for (const doc of existingDocs) {
                    if (!processedPaths.has(doc.absolute_path)) {
                        await this.documents.delete(doc.relative_path, false);
                    }
                }
                // Sort by path length descending to delete children first
                existingFolders.sort((a,b) => b.absolute_path.length - a.absolute_path.length);
                for (const folder of existingFolders) {
                    if (!processedPaths.has(folder.absolute_path)) {
                        const stillThere = this.documents.query.getFolderByPath(folder.relative_path);
                        if (stillThere) await this.documents.delete(folder.relative_path, true);
                    }
                }
            }

        } catch (error) {
            console.error(`Failed to import issue:`, error);
            throw error;
        } finally {
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    }
}
