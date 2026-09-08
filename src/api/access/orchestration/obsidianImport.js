/**
 * obsidianImport.js
 * Orchestrator to parse and import Obsidian vault ZIP packages into Flashback.
 */

import AdmZip from 'adm-zip';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Documents from './documents.js';
import Files from '../resources/files.js';
import query from '../resources/query.js';
import db from '../primitives/database.js';

const CLOZE_PATTERN = /\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g;

const TEMPLATER_CORE_VARS = new Set(['title', 'date', 'time', 'folder', 'cursor']);
function isTemplaterPlaceholderLine(line) {
    if (/^#{1,6}\s/.test(line.trim())) return true;
    const bracketContent = line.match(/\{\{([^{}]+)\}\}/)?.[1]?.trim().toLowerCase();
    return !!bracketContent && TEMPLATER_CORE_VARS.has(bracketContent);
}

export default class ObsidianImport {
    constructor() {
        this.documents = new Documents();
        this.files = new Files();
        this.query = query;
    }

    /**
     * Imports an Obsidian vault ZIP package into the workspace.
     *
     * @param {Buffer} fileBuffer
     * @param {string} targetRelPath
     * @returns {Promise<{ ok: boolean, path: string }>}
     */
    async importVault(fileBuffer, targetRelPath = "") {
        console.log(`Importing Obsidian vault into ${targetRelPath}`);
        const tempId = crypto.randomUUID();
        const tempRoot = path.join(os.tmpdir(), 'flashback_obsidian_imports', tempId);
        const tempZipPath = path.join(tempRoot, 'vault.zip');

        fs.mkdirSync(tempRoot, { recursive: true });
        fs.writeFileSync(tempZipPath, fileBuffer);

        try {
            const zip = new AdmZip(tempZipPath);
            zip.extractAllTo(tempRoot, true);

            let vaultRoot = tempRoot;
            const rootEntries = fs.readdirSync(tempRoot, { withFileTypes: true })
                .filter(e => e.name !== 'vault.zip' && !e.name.startsWith('.'));
            const nonHiddenDirs = rootEntries.filter(e => e.isDirectory());
            if (nonHiddenDirs.length === 1 && rootEntries.length === 1) {
                vaultRoot = path.join(tempRoot, nonHiddenDirs[0].name);
            }

            const importFolderName = `Obsidian_Import_${Date.now()}`;
            const importFolderRel = path.join(targetRelPath, importFolderName);
            await this.documents.createFolder(importFolderName, targetRelPath);

            const noteMap = new Map();
            const mdFiles = [];
            const mediaFiles = [];

            const firstPassCrawl = (currentDir, relDir) => {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    const fullPath = path.join(currentDir, entry.name);
                    const currentRel = path.join(relDir, entry.name);

                    if (entry.isDirectory()) {
                        firstPassCrawl(fullPath, currentRel);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (ext === '.md') {
                            const nameWithoutExt = path.basename(entry.name, '.md');
                            const relPathKey = currentRel.replace(/\\/g, '/');
                            
                            const docHashRaw = `obsidian-doc-${relPathKey}`;
                            const docHash = crypto.createHash('sha256').update(docHashRaw).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
                            
                            noteMap.set(nameWithoutExt.toLowerCase(), docHash);
                            noteMap.set(relPathKey.toLowerCase(), docHash);
                            mdFiles.push({
                                fullPath,
                                relPath: currentRel,
                                name: entry.name,
                                globalHash: docHash
                            });
                        } else {
                            const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp3', '.wav', '.ogg', '.pdf'];
                            if (mediaExtensions.includes(ext)) {
                                mediaFiles.push({
                                    fullPath,
                                    name: entry.name
                                });
                            }
                        }
                    }
                }
            };
            firstPassCrawl(vaultRoot, "");

            const secondPassCrawl = async (currentDir, destRelDir) => {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    const fullPath = path.join(currentDir, entry.name);
                    const entryDestRel = path.join(destRelDir, entry.name);

                    if (entry.isDirectory()) {
                        await this.documents.createFolder(entry.name, destRelDir);
                        await secondPassCrawl(fullPath, entryDestRel);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (ext === '.md') {
                            const fileInfo = mdFiles.find(f => f.fullPath === fullPath);
                            const globalHash = fileInfo ? fileInfo.globalHash : crypto.randomUUID();

                            let content = fs.readFileSync(fullPath, 'utf-8');

                            const tags = [];
                            const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                            if (frontmatterMatch) {
                                const fmText = frontmatterMatch[1];
                                const lines = fmText.split(/\r?\n/);
                                let inTagsList = false;
                                for (const line of lines) {
                                    const trimmed = line.trim();
                                    if (/^(?:tags|tag)\s*:/i.test(trimmed)) {
                                        const afterColon = trimmed.split(/:(.+)/)[1]?.trim() || "";
                                        if (afterColon) {
                                            if (afterColon.startsWith('[') && afterColon.endsWith(']')) {
                                                const list = afterColon.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
                                                tags.push(...list);
                                            } else {
                                                tags.push(...afterColon.split(/\s*,\s*/).map(s => s.trim()));
                                            }
                                            inTagsList = false;
                                        } else {
                                            inTagsList = true;
                                        }
                                    } else if (inTagsList && /^\s*-\s+(.+)/.test(line)) {
                                        const val = line.match(/^\s*-\s+(.+)/)[1].trim().replace(/['"]/g, '');
                                        tags.push(val);
                                    } else if (trimmed && !/^\s*-\s+/.test(line)) {
                                        inTagsList = false;
                                    }
                                }
                            }

                            content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
                            content = content.replace(/%%[\s\S]*?%%/g, '');

                            const contentForTags = content.replace(/```[\s\S]*?```/g, '');
                            const inlineTagMatches = contentForTags.matchAll(/(?:^|\s)#([a-zA-Z0-9_\-/]+)/g);
                            for (const m of inlineTagMatches) {
                                const tag = m[1].replace(/\/+$/, '');
                                if (tag && !/^[0-9]+$/.test(tag)) {
                                    tags.push(tag);
                                }
                            }

                            const mediaDirRel = path.join(destRelDir, 'media');
                            const mediaDirAbs = this.files.safePath(mediaDirRel);

                            const resolveMedia = async (fileName) => {
                                const mFile = mediaFiles.find(f => f.name.toLowerCase() === fileName.toLowerCase());
                                if (!mFile) return null;

                                if (!fs.existsSync(mediaDirAbs)) {
                                    fs.mkdirSync(mediaDirAbs, { recursive: true });
                                }

                                const copiedName = `${path.basename(fileName, path.extname(fileName))}-${crypto.randomUUID().slice(0, 8)}${path.extname(fileName)}`;
                                const destPath = path.join(mediaDirAbs, copiedName);
                                fs.copyFileSync(mFile.fullPath, destPath);

                                const fileBuf = fs.readFileSync(destPath);
                                const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
                                await db.transaction(async () => {
                                    await this.query.insertMedia({
                                        hash: fileHash,
                                        name: copiedName,
                                        relativePath: path.join(mediaDirRel, copiedName),
                                        absolutePath: destPath
                                    });
                                })();

                                return copiedName;
                            };

                            content = content.replace(/!\[\[([^\]]+)\]\]/g, async (match, mediaRef) => {
                                const copied = await resolveMedia(mediaRef.trim());
                                if (copied) {
                                    return `![](./media/${copied})`;
                                }
                                return match;
                            });

                            content = content.replace(/\[\[([^\]|#\n]+)(?:#[^\]|#\n]+)?(?:\|([^\]\n]+))?\]\]/g, (match, target, alias) => {
                                const targetClean = target.trim();
                                const aliasClean = alias ? alias.trim() : targetClean;
                                const targetKey = targetClean.toLowerCase();

                                let targetHash = noteMap.get(targetKey);
                                if (!targetHash) {
                                    const hash = crypto.createHash('sha256').update(targetKey).digest('hex');
                                    targetHash = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
                                }
                                return `[${aliasClean}](flashback://${targetHash})`;
                            });

                            const flashcards = [];
                            const lines = content.split(/\r?\n/);
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];

                                if (line.includes(' :: ') && !line.includes(' ::: ')) {
                                    const parts = line.split(' :: ');
                                    const front = parts[0].trim();
                                    const back = parts[1].trim();

                                    const cardHashRaw = `obsidian-card-${globalHash}-${i}`;
                                    const cardHash = crypto.createHash('sha256').update(cardHashRaw).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

                                    flashcards.push({
                                        name: `Obsidian Card ${flashcards.length + 1}`,
                                        globalHash: cardHash,
                                        level: 0,
                                        easeFactor: 2.5,
                                        presence: 0.0,
                                        tags: [],
                                        category: 'Concept',
                                        cardType: 'basic',
                                        vanillaData: { frontText: front, backText: back, media: {} },
                                        customData: { html: "" }
                                    });
                                } else if (line.includes(' ::: ')) {
                                    const parts = line.split(' ::: ');
                                    const front = parts[0].trim();
                                    const extra = parts[1].trim();
                                    const cleanedFront = front.replace(CLOZE_PATTERN, '{{$1}}');

                                    const cardHashRaw = `obsidian-cloze-${globalHash}-${i}`;
                                    const cardHash = crypto.createHash('sha256').update(cardHashRaw).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

                                    flashcards.push({
                                        name: `Obsidian Card ${flashcards.length + 1}`,
                                        globalHash: cardHash,
                                        level: 0,
                                        easeFactor: 2.5,
                                        presence: 0.0,
                                        tags: [],
                                        category: 'Concept',
                                        cardType: 'cloze',
                                        vanillaData: { frontText: cleanedFront, backText: extra || cleanedFront, media: {} },
                                        customData: { html: "" }
                                    });
                                } else if (line.includes('{{') && line.includes('}}') && !isTemplaterPlaceholderLine(line)) {
                                    const cleanedFront = line.replace(CLOZE_PATTERN, '{{$1}}').trim();
                                    const cardHashRaw = `obsidian-cloze-inline-${globalHash}-${i}`;
                                    const cardHash = crypto.createHash('sha256').update(cardHashRaw).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

                                    flashcards.push({
                                        name: `Obsidian Card ${flashcards.length + 1}`,
                                        globalHash: cardHash,
                                        level: 0,
                                        easeFactor: 2.5,
                                        presence: 0.0,
                                        tags: [],
                                        category: 'Concept',
                                        cardType: 'cloze',
                                        vanillaData: { frontText: cleanedFront, backText: cleanedFront, media: {} },
                                        customData: { html: "" }
                                    });
                                } else if (line.includes('#card')) {
                                    const front = line.replace('#card', '').trim();
                                    const back = lines[i + 1]?.trim() || '';
                                    if (front && back) {
                                        const cardHashRaw = `obsidian-multiline-${globalHash}-${i}`;
                                        const cardHash = crypto.createHash('sha256').update(cardHashRaw).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

                                        flashcards.push({
                                            name: `Obsidian Card ${flashcards.length + 1}`,
                                            globalHash: cardHash,
                                            level: 0,
                                            easeFactor: 2.5,
                                            presence: 0.0,
                                            tags: [],
                                            category: 'Concept',
                                            cardType: 'basic',
                                            vanillaData: { frontText: front, backText: back, media: {} },
                                            customData: { html: "" }
                                        });
                                    }
                                }
                            }

                            const fileMetadata = {
                                globalHash,
                                tags: [...new Set(tags)],
                                flashcards
                            };

                            await this.documents.importFile(entry.name, destRelDir, content, fileMetadata);
                        } else {
                            const destAbs = this.files.safePath(entryDestRel);
                            const destDir = path.dirname(destAbs);
                            if (!fs.existsSync(destDir)) {
                                fs.mkdirSync(destDir, { recursive: true });
                            }
                            fs.copyFileSync(fullPath, destAbs);

                            const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp3', '.wav', '.ogg', '.pdf'];
                            if (mediaExtensions.includes(ext)) {
                                const fileBuf = fs.readFileSync(destAbs);
                                const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
                                await db.transaction(async () => {
                                    await this.query.insertMedia({
                                        hash: fileHash,
                                        name: entry.name,
                                        relativePath: entryDestRel,
                                        absolutePath: destAbs
                                    });
                                })();
                            }
                        }
                    }
                }
            };
            await secondPassCrawl(vaultRoot, importFolderRel);

            return { ok: true, path: importFolderRel };
        } catch (e) {
            console.error("Obsidian import failed:", e);
            throw e;
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }
}
