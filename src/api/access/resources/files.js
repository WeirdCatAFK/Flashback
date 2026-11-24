import path from "path";
import fs from "fs";
import crypto from "crypto";
import iconv from "iconv-lite";
import chardet from "chardet";
import { getAuthorString, getWorkspacePath } from "../primitives/config.js";
import { currentAuthorString } from "../../requestContext.js";
import newFileMetadata from "../../config/defaults/FlashbackFile.js";
import newFolderMetadata from "../../config/defaults/FlashbackFolder.js";
import { LATEST_VERSION } from "../../config/updates/registry.js";

const BINARY_SNIFF_BYTES = 8000;

const BINARY_EXTENSIONS = new Set([
    ".pdf", ".epub", ".zip", ".apkg", ".docx", ".xlsx", ".pptx", ".odt",
]);

export const EDITABLE_BODY_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);

function stampedBy() {
    return currentAuthorString(getAuthorString);
}

function looksBinary(relPath, sample, encoding) {
    if (BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return true;
    if (encoding && /^utf-?(16|32)/i.test(encoding)) return false;
    return sample.includes(0);
}

export function workspaceRoot() {
    return getWorkspacePath();
}

export function ensureRoot() {
    const root = workspaceRoot();
    if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
    }
    return root;
}

export function safePath(anyPath) {
    const resolvedPath = path.resolve(workspaceRoot(), anyPath);
    const relative = path.relative(workspaceRoot(), resolvedPath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw Object.assign(
            new Error(`Path traversal outside of workspace is not allowed: ${anyPath}`),
            { status: 400, code: "path_traversal" },
        );
    }

    return resolvedPath;
}

export function mediaName(name) {
    const raw = String(name ?? "");
    const bad =
        !raw ||
        raw === "." ||
        raw === ".." ||
        raw.includes("/") || raw.includes("\\") ||
        /^[A-Za-z]:/.test(raw) ||
        raw.includes("\0") ||
        path.isAbsolute(raw);
    if (bad) throw new Error(`Invalid media name: ${raw}`);
    return raw;
}

export function mediaPathFor(anyPath, name) {
    const docRel = path.relative(workspaceRoot(), safePath(anyPath));
    return safePath(path.join(path.dirname(docRel), "media", mediaName(name)));
}

export function exists(relPath) {
    try {
        return fs.existsSync(safePath(relPath));
    } catch {
        return false;
    }
}

function _atomicWrite(absPath, data, options) {
    const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmp, data, options);
        fs.renameSync(tmp, absPath);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
}

function _metadataPathFor(relPath, isFolder = false) {
    const resolved = safePath(relPath);
    return isFolder ? path.join(resolved, ".flashback") : `${resolved}.flashback`;
}

function _resolveCopyName(dirPath, baseName) {
    const ext = path.extname(baseName);
    const name = path.basename(baseName, ext);

    let candidate = `${name} (copy)${ext}`;
    let counter = 2;

    while (fs.existsSync(path.join(dirPath, candidate))) {
        candidate = `${name} (copy ${counter})${ext}`;
        counter++;
    }

    return candidate;
}

function _regenerateIdentities(absPath) {
    let items = [];
    
    const folderRel = path.relative(workspaceRoot(), absPath);
    
    let folderMeta = getMetadata(folderRel, true);
    if (!folderMeta) folderMeta = newFolderMetadata();
    
    const oldFolderHash = folderMeta.globalHash;
    folderMeta.globalHash = crypto.randomUUID();
    folderMeta.copiedFrom = oldFolderHash;
    folderMeta.createdAt = new Date().toISOString();
    
    writeMetadata(folderRel, folderMeta, true);

    items.push({
        type: 'folder',
        relativePath: folderRel,
        absolutePath: absPath,
        globalHash: folderMeta.globalHash,
        name: path.basename(absPath)
    });

    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    
    for (const entry of entries) {
        if (entry.name === '.flashback' || entry.name.endsWith('.flashback')) continue;

        const entryAbsPath = path.join(absPath, entry.name);
        const entryRel = path.relative(workspaceRoot(), entryAbsPath);

        if (entry.isDirectory()) {
            const childItems = _regenerateIdentities(entryAbsPath);
            items = items.concat(childItems);
        } else {
            let fileMeta = getMetadata(entryRel, false);
            if (!fileMeta) fileMeta = newFileMetadata();

            const oldFileHash = fileMeta.globalHash;
            fileMeta.globalHash = crypto.randomUUID();
            fileMeta.copiedFrom = oldFileHash;
            fileMeta.createdAt = new Date().toISOString();
            fileMeta.name = entry.name;
            if (Array.isArray(fileMeta.flashcards)) {
                for (const fc of fileMeta.flashcards) {
                    fc.copiedFrom = fc.globalHash;
                    fc.globalHash = crypto.randomUUID();
                    fc.level = 0;
                    delete fc.lastRecall;
                    delete fc.fsrsStability; delete fc.fsrsDifficulty; delete fc.fsrsDue;
                    delete fc.fsrsState; delete fc.fsrsReps; delete fc.fsrsLapses;
                }
            }

            writeMetadata(entryRel, fileMeta, false);

            items.push({
                type: 'file',
                relativePath: entryRel,
                absolutePath: entryAbsPath,
                globalHash: fileMeta.globalHash,
                name: entry.name
            });
        }
    }
    
    return items;
}

export function etag(relPath, isFolder = false) {
    const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    let body = null;
    let sidecar = null;

    const metadataPath = _metadataPathFor(relPath, isFolder);
    if (fs.existsSync(metadataPath)) sidecar = digest(fs.readFileSync(metadataPath));

    if (!isFolder && EDITABLE_BODY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) {
        const abs = safePath(relPath);
        if (fs.existsSync(abs)) body = digest(fs.readFileSync(abs));
    }

    if (body === null && sidecar === null) return null;
    return `${body ?? '-'}.${sidecar ?? '-'}`;
}

export function entityEtag(entity) {
    if (entity == null) return null;
    const stable = (value) => {
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === 'object') {
            return Object.keys(value).sort().reduce((out, k) => {
                out[k] = stable(value[k]);
                return out;
            }, {});
        }
        return value;
    };
    return crypto.createHash('sha256').update(JSON.stringify(stable(entity))).digest('hex');
}

export function getMetadata(relPath, isFolder = false) {
    try {
        const metadataPath = _metadataPathFor(relPath, isFolder);
        if (!fs.existsSync(metadataPath)) return null;
        const raw = fs.readFileSync(metadataPath, "utf-8");
        return JSON.parse(raw);
    } catch (err) {
        console.error("Error reading metadata for", relPath, err);
        return null;
    }
}

export function writeMetadata(relPath, metadata, isFolder = false) {
    try {
        _ensureFlashcardHashes(metadata);
        const metadataPath = _metadataPathFor(relPath, isFolder);
        _ensureFormatVersion(metadata, metadataPath);
        const parent = path.dirname(metadataPath);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

        _atomicWrite(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
    } catch (err) {
        console.error("Error writing metadata for", relPath, err);
        throw err;
    }
}

function _ensureFormatVersion(metadata, metadataPath) {
    if (!metadata || typeof metadata !== 'object') return;
    if (metadata.formatVersion !== undefined) return;
    if (fs.existsSync(metadataPath)) return;
    metadata.formatVersion = LATEST_VERSION;
}

function _ensureGlobalHash(metadata, isFolder = false) {
    if (!metadata) metadata = isFolder ? newFolderMetadata() : newFileMetadata();
    if (!metadata.globalHash) {
        metadata.globalHash = crypto.randomUUID();
    }
    return metadata;
}

function _ensureFlashcardHashes(metadata) {
    if (!metadata || !Array.isArray(metadata.flashcards)) return metadata;
    for (const fc of metadata.flashcards) {
        if (fc && !fc.globalHash) fc.globalHash = crypto.randomUUID();
    }
    return metadata;
}

export function createFile(relPath, name) {
    if (name.endsWith('.flashback')) throw new Error('Cannot create .flashback files directly');
    if (!path.extname(name)) name = name + '.md';
    const dirResolved = safePath(relPath);
    const fileRel = path.join(relPath, name);
    const filePath = safePath(fileRel);

    if (exists(fileRel)) {
        throw new Error(`File ${name} already exists at ${relPath}`);
    }

    try {
        if (!fs.existsSync(dirResolved)) fs.mkdirSync(dirResolved, { recursive: true });

        fs.writeFileSync(filePath, "");

        let metadata = newFileMetadata();
        metadata = _ensureGlobalHash(metadata, false);
        metadata.name = name;
        metadata.createdBy = metadata.createdBy || stampedBy();
        metadata.createdAt = metadata.createdAt || new Date().toISOString();

        writeMetadata(fileRel, metadata, false);

        return { globalHash: metadata.globalHash, name };
    } catch (err) {
        console.error("Error creating file:", err);
        throw err;
    }
}

export function createFolder(relPath, name) {
    const lower = name.trim().toLowerCase();
    if (lower === '.flashback' || lower.endsWith('.flashback')) throw new Error('Cannot create .flashback folders directly');
    if (lower === 'media') throw new Error('Cannot create a folder named "media"; it is reserved for flashcard assets');
    const folderRel = path.join(relPath, name);
    const folderPath = safePath(folderRel);

    if (exists(folderRel)) {
        const kind = fs.lstatSync(folderPath).isDirectory() ? 'Folder' : 'File';
        throw new Error(`${kind} ${name} already exists at ${relPath}`);
    }

    try {
        fs.mkdirSync(folderPath, { recursive: true });

        let metadata = newFolderMetadata();
        metadata = _ensureGlobalHash(metadata, true);
        metadata.name = name;
        metadata.createdBy = metadata.createdBy || stampedBy();
        metadata.createdAt = metadata.createdAt || new Date().toISOString();

        writeMetadata(folderRel, metadata, true);

        return metadata.globalHash;
    } catch (err) {
        console.error("Error creating folder:", err);
        throw err;
    }
}

export function ensureFolderMetadata(relPath, name) {
    const folderRel = path.join(relPath, name);
    const folderPath = safePath(folderRel);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

    const existing = getMetadata(folderRel, true);
    if (existing && existing.globalHash) return existing.globalHash;

    let metadata = existing || newFolderMetadata();
    metadata = _ensureGlobalHash(metadata, true);
    metadata.name = name;
    metadata.createdBy = metadata.createdBy || stampedBy();
    metadata.createdAt = metadata.createdAt || new Date().toISOString();

    writeMetadata(folderRel, metadata, true);
    return metadata.globalHash;
}

export function rename(relPath, newName, isFolder = false) {
    const lower = newName.trim().toLowerCase();
    if (lower === '.flashback' || lower.endsWith('.flashback')) throw new Error('Cannot rename to a .flashback name; it is reserved for Flashback metadata');
    if (isFolder && lower === 'media') throw new Error('Cannot rename a folder to "media"; it is reserved for flashcard assets');
    const oldPath = safePath(relPath);
    const dirname = path.dirname(relPath);
    const newRel = path.join(dirname, newName);
    const newPath = safePath(newRel);

    if (!exists(relPath)) throw new Error("Source does not exist");
    if (exists(newRel)) throw new Error("Target already exists in destination folder");

    try {
        fs.renameSync(oldPath, newPath);

        if (!isFolder) {
            const oldMeta = `${oldPath}.flashback`;
            const newMeta = `${newPath}.flashback`;
            if (fs.existsSync(oldMeta)) {
                fs.renameSync(oldMeta, newMeta);
            } else {
                const meta = getMetadata(newRel, false) || newFileMetadata();
                meta.name = newName;
                writeMetadata(newRel, meta, false);
            }
        } else {
            const folderMetaPath = path.join(newPath, ".flashback");
            if (fs.existsSync(folderMetaPath)) {
                try {
                    const m = JSON.parse(fs.readFileSync(folderMetaPath, "utf-8"));
                    m.name = newName;
                    fs.writeFileSync(folderMetaPath, JSON.stringify(m, null, 2), "utf-8");
                } catch (err) {
                    console.error("Failed updating folder metadata name after rename:", err);
                }
            }
        }
    } catch (err) {
        console.error("Error renaming:", err);
        throw err;
    }
}

export function move(relPath, newRelPath, isFolder = false) {
    const oldPath = safePath(relPath);
    const newPath = safePath(newRelPath);

    if (!exists(relPath)) throw new Error("Source does not exist");
    if (exists(newRelPath)) throw new Error("Target already exists");

    try {
        const destParent = path.dirname(newPath);
        if (!fs.existsSync(destParent)) fs.mkdirSync(destParent, { recursive: true });

        fs.renameSync(oldPath, newPath);

        if (!isFolder) {
            const oldMeta = `${oldPath}.flashback`;
            const newMeta = `${newPath}.flashback`;
            if (fs.existsSync(oldMeta)) {
                fs.renameSync(oldMeta, newMeta);
            }
        }
    } catch (err) {
        console.error("Error moving:", err);
        throw err;
    }
}

export function remove(relPath, isFolder = false) {
    const target = safePath(relPath);
    if (!exists(relPath)) throw new Error("Target does not exist");

    try {
        if (isFolder) {
            fs.rmSync(target, { recursive: true, force: true });
        } else {
            fs.unlinkSync(target);
            const metaPath = `${target}.flashback`;
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        }
    } catch (err) {
        console.error("Error deleting:", err);
        throw err;
    }
}

export function copy(relPath, newRelPath, isFolder = false) {
    const src = safePath(relPath);
    const dest = safePath(newRelPath);

    if (!exists(relPath)) throw new Error("Source does not exist");

    const srcDir = path.dirname(src);
    const destDir = path.dirname(dest);

    try {
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        let finalDest = dest;

        if (fs.existsSync(dest)) {
             if (srcDir === destDir || fs.existsSync(dest)) {
                const newName = _resolveCopyName(destDir, path.basename(dest));
                finalDest = path.join(destDir, newName);
            }
        }

        if (isFolder) {
            fs.cpSync(src, finalDest, { recursive: true });
            
            return _regenerateIdentities(finalDest);
        } else {
            fs.copyFileSync(src, finalDest);
            
            const srcMeta = getMetadata(relPath, false);
            let newMeta = srcMeta ? structuredClone(srcMeta) : newFileMetadata();
            
            newMeta.globalHash = crypto.randomUUID();
            newMeta.copiedFrom = srcMeta?.globalHash;
            newMeta.name = path.basename(finalDest);
            newMeta.createdAt = new Date().toISOString();
            if (Array.isArray(newMeta.flashcards)) {
                for (const fc of newMeta.flashcards) {
                    fc.copiedFrom = fc.globalHash;
                    fc.globalHash = crypto.randomUUID();
                    fc.level = 0;
                    delete fc.lastRecall;
                    delete fc.fsrsStability; delete fc.fsrsDifficulty; delete fc.fsrsDue;
                    delete fc.fsrsState; delete fc.fsrsReps; delete fc.fsrsLapses;
                }
            }

            const destRel = path.relative(workspaceRoot(), finalDest);
            writeMetadata(destRel, newMeta, false);

            return [{
                type: 'file',
                relativePath: destRel,
                absolutePath: finalDest,
                globalHash: newMeta.globalHash,
                name: newMeta.name
            }];
        }
    } catch (error) {
        console.error("Error copying:", error);
        throw error;
    }
}

export function updateFile(relPath, content, metadata, encoding = "utf-8") {
    const filePath = safePath(relPath);

    if (!exists(relPath)) {
        throw Object.assign(new Error("File does not exist"), { status: 404 });
    }

    try {
        const isBuffer = Buffer.isBuffer(content);

        if (!isBuffer && content != null && isBinaryFile(relPath)) {
            throw new Error(
                `Cannot overwrite the binary file ${relPath} with text content. ` +
                `Re-import the file instead; its flashcards, tags and highlights are edited through its sidecar.`
            );
        }

        if (isBuffer) {
            const detected = chardet.detect(content);
            encoding = (detected && iconv.encodingExists(detected)) ? detected : 'binary';
            _atomicWrite(filePath, content);
        } else if (content != null) {
            _atomicWrite(filePath, content, { encoding: (encoding) });
        } else {
            encoding = getMetadata(relPath, false)?.encoding ?? encoding;
        }

        const existing = getMetadata(relPath, false) || {};
        const toWrite = metadata ? { ...metadata } : { ...existing };
        if (existing.globalHash) toWrite.globalHash = existing.globalHash;
        toWrite.encoding = encoding;
        writeMetadata(relPath, toWrite, false);

        return encoding;
    } catch (err) {
        console.error("Error updating file:", err);
        throw err;
    }
}

export function addVanillaData(anyPath, data, name, type, position, cardIndex, encoding = "binary") {
    const filePath = safePath(anyPath);
    if (!fs.existsSync(filePath)) throw new Error("Parent File does not exist.");

    const mediaPath = mediaPathFor(anyPath, name);
    const mediaDir = path.dirname(mediaPath);
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    if (fs.existsSync(mediaPath)) throw new Error("Media file already exists.");

    try {
        fs.writeFileSync(mediaPath, data, { encoding });

        const metadata = getMetadata(anyPath);
        if (!metadata || !Array.isArray(metadata.flashcards) || !metadata.flashcards[cardIndex]) {
            fs.unlinkSync(mediaPath);
            throw new Error(`Flashcard at index ${cardIndex} does not exist.`);
        }

        const targetCard = metadata.flashcards[cardIndex];
        if (!targetCard.vanillaData) targetCard.vanillaData = {};
        if (!targetCard.vanillaData.media) targetCard.vanillaData.media = {};

        if (type === "sound" && position === "front") targetCard.vanillaData.media.front_sound = `./media/${name}`;
        if (type === "sound" && position === "back") targetCard.vanillaData.media.back_sound = `./media/${name}`;
        if (type === "image" && position === "front") targetCard.vanillaData.media.front_img = `./media/${name}`;
        if (type === "image" && position === "back") targetCard.vanillaData.media.back_img = `./media/${name}`;

        writeMetadata(anyPath, metadata, false);

        return { mediaPath };
    } catch (err) {
        console.error("Error adding vanilla data:", err);
        throw err;
    }
}

export function addCustomMedia(anyPath, data, name, cardIndex = undefined, encoding = "binary") {
    const filePath = safePath(anyPath);
    if (!fs.existsSync(filePath)) throw new Error("Parent File does not exist.");

    const mediaPath = mediaPathFor(anyPath, name);
    const mediaDir = path.dirname(mediaPath);
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    if (fs.existsSync(mediaPath)) throw new Error("Media file already exists.");

    try {
        fs.writeFileSync(mediaPath, data, { encoding: (encoding) });

        const trimmedName = name.split(".")[0];

        const metadata = getMetadata(anyPath);
        if (!metadata || !Array.isArray(metadata.flashcards) || cardIndex == null || !metadata.flashcards[cardIndex]) {
            fs.unlinkSync(mediaPath);
            throw new Error(`Flashcard at index ${cardIndex} does not exist.`);
        }

        const targetCard = metadata.flashcards[cardIndex];
        if (!targetCard.customData) targetCard.customData = {};
        if (!targetCard.customData.media) targetCard.customData.media = {};

        targetCard.customData.media[trimmedName] = `./media/${name}`;

        writeMetadata(anyPath, metadata, false);

        return { mediaPath, mediaId: trimmedName };
    } catch (err) {
        console.error("Error adding custom media:", err);
        throw err;
    }
}

export function removeCustomMedia(anyPath, name) {
    const filePath = safePath(anyPath);
    if (!fs.existsSync(filePath)) {
        throw new Error("File does not exist.");
    }

    const mediaPath = mediaPathFor(anyPath, name);
    try {
        if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
        const metadata = getMetadata(anyPath);
        if (metadata && Array.isArray(metadata.flashcards)) {
            let changed = false;
            for (const card of metadata.flashcards) {
                const cm = card.customData?.media;
                if (cm) {
                    for (const key of Object.keys(cm)) {
                        if (cm[key] === `./media/${name}`) {
                            delete cm[key];
                            changed = true;
                        }
                    }
                    if (Object.keys(cm).length === 0) delete card.customData.media;
                }
                const vm = card.vanillaData?.media;
                if (vm) {
                    for (const k of ["front_sound", "back_sound", "front_img", "back_img"]) {
                        if (vm[k] === `./media/${name}`) {
                            delete vm[k];
                            changed = true;
                        }
                    }
                    if (Object.keys(vm).length === 0) delete card.vanillaData.media;
                }
            }
            if (changed) writeMetadata(anyPath, metadata, false);
        }
    } catch (err) {
        console.error("Error removing custom media:", err);
        throw err;
    }
}

export function readFile(anyPath) {
    const filePath = safePath(anyPath);

    if (!fs.existsSync(filePath)) {
        throw new Error("File does not exist.");
    }

    try {
        const size = fs.statSync(filePath).size;

        let encoding = chardet.detectFileSync ? chardet.detectFileSync(filePath, { sampleSize: 64 * 1024 }) : null;
        encoding = encoding || "utf-8";

        const fd = fs.openSync(filePath, "r");
        let sample;
        try {
            const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, size));
            const read = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
            sample = buf.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
        if (looksBinary(anyPath, sample, encoding)) {
            return { content: null, encoding: "binary", binary: true, size };
        }

        const rawBuffer = fs.readFileSync(filePath);

        let content;
        if (iconv.encodingExists(encoding)) {
            content = iconv.decode(rawBuffer, encoding);
        } else {
            console.warn(`Encoding ${encoding} not supported by iconv; falling back to utf-8`);
            content = rawBuffer.toString("utf-8");
        }

        return { content, encoding, binary: false, size };
    } catch (err) {
        console.error("Error reading file:", err);
        throw err;
    }
}

export function readBuffer(anyPath) {
    const filePath = safePath(anyPath);
    if (!fs.existsSync(filePath)) throw new Error("File does not exist.");
    return fs.readFileSync(filePath);
}

export function statFile(anyPath) {
    const filePath = safePath(anyPath);
    if (!fs.existsSync(filePath)) throw new Error("File does not exist.");
    const { size, mtimeMs } = fs.statSync(filePath);
    return { size, mtimeMs };
}

export function isBinaryFile(anyPath) {
    const filePath = safePath(anyPath);
    if (!fs.existsSync(filePath)) return false;
    if (BINARY_EXTENSIONS.has(path.extname(anyPath).toLowerCase())) return true;
    const size = fs.statSync(filePath).size;
    if (size === 0) return false;

    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, size));
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const encoding = chardet.detectFileSync ? chardet.detectFileSync(filePath, { sampleSize: 64 * 1024 }) : null;
        return looksBinary(anyPath, buf.subarray(0, read), encoding);
    } finally {
        fs.closeSync(fd);
    }
}

export function walkWorkspace() {
    const folders = [];
    const documents = [];
    const mediaDirs = [];
    const strayItems = [];

    const walk = (relPath) => {
        const absDir = relPath ? safePath(relPath) : workspaceRoot();
        const entries = fs.readdirSync(absDir, { withFileTypes: true });
        const names = new Set(entries.map(e => e.name));

        for (const entry of entries) {
            if (entry.name === ".git") continue;
            if (!relPath && entry.name === "_decks" && entry.isDirectory()) continue;
            const entryRel = relPath ? path.join(relPath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                if (entry.name === "media") {
                    mediaDirs.push(entryRel);
                    continue;
                }
                const sidecarExists = fs.existsSync(path.join(absDir, entry.name, ".flashback"));
                const meta = sidecarExists ? getMetadata(entryRel, true) : null;
                folders.push({
                    relPath: entryRel, meta, sidecarExists,
                    sidecarCorrupt: sidecarExists && meta === null,
                });
                walk(entryRel);
            } else {
                if (entry.name === ".flashback") continue;
                if (entry.name.endsWith(".flashback")) {
                    const owner = entry.name.slice(0, -".flashback".length);
                    if (!names.has(owner)) strayItems.push({ relPath: entryRel, kind: "orphan-sidecar" });
                    continue;
                }
                const sidecarExists = names.has(entry.name + ".flashback");
                if (!sidecarExists) {
                    strayItems.push({ relPath: entryRel, kind: "untracked-file" });
                    continue;
                }
                const meta = getMetadata(entryRel, false);
                documents.push({
                    relPath: entryRel, meta, sidecarExists,
                    sidecarCorrupt: meta === null,
                });
            }
        }
    };

    walk("");
    return { folders, documents, mediaDirs, strayItems };
}

export function listFolder(relPath) {
    const folderPath = safePath(relPath);
    if (!exists(relPath)) throw new Error("Folder does not exist");

    const result = [];
    for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
        if (entry.name === ".flashback" || entry.name.endsWith(".flashback") || entry.name === ".git") continue;
        if (entry.name === "media" && entry.isDirectory()) continue;
        if (entry.name === "_decks" && entry.isDirectory()) continue;
        const isDir = entry.isDirectory();
        const meta = getMetadata(path.join(relPath, entry.name), isDir);
        result.push({ name: entry.name, type: isDir ? "folder" : "file", metadata: meta });
    }
    return result;
}
