import * as Documents from './documents.js';
import AdmZip from 'adm-zip';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import * as documentRows from '../resources/db/documents.js';
import * as folderRows from '../resources/db/folders.js';
import * as subscriptionRows from '../resources/db/subscriptions.js';
import * as Files from '../resources/files.js';

export async function importIssue(magazineId, issueData, targetRelPath) {
    console.log(`Importing issue from ${magazineId} into ${targetRelPath}`);

    const tempRoot = path.join(os.tmpdir(), 'flashback_imports', crypto.randomUUID());
    const tempIssuePath = path.join(tempRoot, 'issue.zip');
    const processedPaths = new Set();

    try {
        await fs.mkdir(tempRoot, { recursive: true });
        await fs.writeFile(tempIssuePath, issueData);

        const zip = new AdmZip(tempIssuePath);
        const entry = zip.getEntries()[0];
        const issueFolderName = entry.entryName.split('/')[0];
        const importRootPath = path.join(tempRoot, issueFolderName);
        zip.extractAllTo(tempRoot, true);

        let issueMetadata = null;
        try {
            const rootMetaPath = path.join(importRootPath, '.flashback');
            issueMetadata = JSON.parse(await fs.readFile(rootMetaPath, 'utf-8'));
        } catch {}

        const crawl = async (currentPath, destRelPath) => {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const srcPath = path.join(currentPath, entry.name);
                const entryRelPath = path.join(destRelPath, entry.name);

                if (entry.name === '.flashback' || entry.name.endsWith('.flashback')) continue;

                if (entry.isDirectory()) {
                    const metaPath = path.join(srcPath, '.flashback');
                    let metadata;
                    try {
                        metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
                    } catch {
                        console.warn(`Missing or invalid .flashback for directory ${srcPath}, skipping metadata.`);
                        metadata = {};
                    }

                    const existingFolder = await folderRows.getByHash(metadata.globalHash) 
                                        || await folderRows.getByPath(entryRelPath);

                    if (existingFolder) {
                        await Documents.updateMetadata(existingFolder.relative_path, metadata, true);
                        processedPaths.add(existingFolder.absolute_path);
                    } else {
                        await Documents.createFolder(entry.name, destRelPath);
                        await Documents.updateMetadata(entryRelPath, metadata, true);
                        const newFolder = await folderRows.getByPath(entryRelPath);
                        if (newFolder) processedPaths.add(newFolder.absolute_path);
                    }
                    await crawl(srcPath, entryRelPath);
                } else {
                    const metaPath = srcPath + '.flashback';
                    let metadata;
                    try {
                        metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
                    } catch {
                        console.warn(`Missing or invalid .flashback for file ${srcPath}, skipping metadata.`);
                        metadata = {};
                    }
                    const content = await fs.readFile(srcPath, 'utf-8');

                    const existingDoc = await documentRows.getByHash(metadata.globalHash)
                                     || await documentRows.getByPath(entryRelPath);

                    if (existingDoc) {
                        await Documents.updateFile(existingDoc.relative_path, content, metadata);
                        processedPaths.add(existingDoc.absolute_path);
                    } else {
                        await Documents.createFile(entry.name, destRelPath);
                        await Documents.updateFile(entryRelPath, content, metadata);
                        const newDoc = await documentRows.getByPath(entryRelPath);
                        if (newDoc) processedPaths.add(newDoc.absolute_path);
                    }
                }
            }
        };

        await crawl(importRootPath, targetRelPath);

        if (issueMetadata && issueMetadata.subscription) {
            const sub = issueMetadata.subscription;
            await subscriptionRows.upsert({
                magazineId: sub.magazineId,
                issueId: sub.issueId,
                version: sub.version,
                targetPath: targetRelPath
            });

            const targetMeta = Files.getMetadata(targetRelPath, true) || {};
            targetMeta.subscription = sub;
            await Documents.updateMetadata(targetRelPath, targetMeta, true);
        }

        const targetFolder = await folderRows.getByPath(targetRelPath);
        if (targetFolder) {
            const prefix = targetFolder.absolute_path + path.sep;
            const existingDocs = await documentRows.getByAbsPathPrefix(prefix);
            const existingFolders = await folderRows.getByAbsPathPrefix(prefix, targetFolder.absolute_path);

            for (const doc of existingDocs) {
                if (!processedPaths.has(doc.absolute_path)) {
                    await Documents.remove(doc.relative_path, false);
                }
            }
            existingFolders.sort((a, b) => b.absolute_path.length - a.absolute_path.length);
            for (const folder of existingFolders) {
                if (!processedPaths.has(folder.absolute_path)) {
                    const stillThere = await folderRows.getByPath(folder.relative_path);
                    if (stillThere) await Documents.remove(folder.relative_path, true);
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

export async function get(magazineId) {
    return await subscriptionRows.get(magazineId);
}
