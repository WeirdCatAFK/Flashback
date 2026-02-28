/* 
 A bridge for the operations of the flashback canonical data system.
 Default: all file operations are handled inside the flashback directory at userData.
 If the config provides a custom path it will be used instead to mount files elsewhere.

 Some things to be aware of:
 Since the system uses a derived data system, the file reads are done at the document.js level
 The canonical data system is a group of jsons with metadata and a media file at root level of folders check out datamodel.md
 The canonical data makes all writes to the file system, document.js makes all writes to the database and calls  files.js

 Las rutas relativas se resuelven contra el workspaceRoot.
 The metadata of the files is stored as <file>.flashback o <folder>/.flashback
 The globalHash is inmutable after generated, copying a file will generate a new one.
 Insecure operations throw errors to be handled by the UI

*/

import path from "path";
import fs from "fs";
import crypto from "crypto";
import iconv from "iconv-lite";
import chardet from "chardet";
import { get as config } from "./config.js";
import newFileMetadata from "./../config/defaults/FlashbackFile.js";
import newFolderMetadata from "./../config/defaults/FlashbackFolder.js";

export default class Files {
    /**
     * Constructor for the Files class.
     * 
     * If the config provides a custom path it will be used instead to mount files elsewhere.
     * If the custom path is not absolute, an error will be thrown.
     * If the config does not provide a custom path, the USER_DATA_PATH environment variable will be used.
     * If the USER_DATA_PATH environment variable is not defined, an error will be thrown.
     * The workspace root will be set to the provided path or the default path.
     * If the workspace root does not exist, it will be created recursively.
     */
    constructor() {
        this.config = config();

        if (this.config.isCustomPath) {
            if (path.isAbsolute(this.config.customPath)) {
                this.workspaceRoot = this.config.customPath;
            } else {
                throw new Error("Custom path provided is not absolute");
            }
        } else {
            const baseDir = process.env.USER_DATA_PATH || path.join(process.cwd(), "data");
            this.workspaceRoot = path.join(baseDir, "workspace");
        }

        if (!fs.existsSync(this.workspaceRoot)) {
            fs.mkdirSync(this.workspaceRoot, { recursive: true });
        }
    }

    // ---------- HELPERS ----------

    /**
     * Safely resolves a path relative to the workspace root.
     * If the path is absolute or traverses outside of the workspace, an error is thrown.
     * @param {string} anyPath - The path to be resolved.
     * @returns {string} The resolved path.
     * @throws {Error} If the path is absolute or traverses outside of the workspace.
     */
    safePath(anyPath) {
        // Normalize and resolve relative to workspace root
        const resolvedPath = path.resolve(this.workspaceRoot, anyPath);
        const relative = path.relative(this.workspaceRoot, resolvedPath);

        // Prevent traversal outside workspace
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Path traversal outside of workspace is not allowed: ${anyPath}`);
        }

        return resolvedPath;
    }

    /**
     * Checks if a file or folder exists at the given relative path.
     * If safePath throws an error (i.e. the path is absolute or traverses outside of the workspace),
     * it is considered non-existent and false is returned.
     * @param {string} relPath - The relative path to check for existence.
     * @returns {boolean} True if the file or folder exists, false otherwise.
     */
    exists(relPath) {
        try {
            return fs.existsSync(this.safePath(relPath));
        } catch (err) {
            // If safePath throws, consider it non-existent (but rethrow might be better for caller)
            return false;
        }
    }

    /**
     * Computes the path to the metadata file associated with the given relative path.
     * If isFolder is true, the path is interpreted as a folder and the metadata path is inside the folder with the name ".flashback".
     * If isFolder is false, the path is interpreted as a file and the metadata path is the file path with ".flashback" appended.
     * @param {string} relPath - The relative path for which to compute the metadata path.
     * @param {boolean} isFolder - Whether the path is interpreted as a folder or a file.
     * @returns {string} The computed metadata path.
     */
    _metadataPathFor(relPath, isFolder = false) {
        const resolved = this.safePath(relPath);
        return isFolder ? path.join(resolved, ".flashback") : `${resolved}.flashback`;
    }

    /**
     * Resolve a copy name for a file to be written in the given directory.
     * If a file with the same name already exists, increment the counter until a free name is found.
     * @param {string} dirPath - The directory in which to write the file.
     * @param {string} baseName - The base name of the file to be written (without extension).
     * @returns {string} The resolved copy name.
     */
    _resolveCopyName(dirPath, baseName) {
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
_regenerateIdentities(absPath) {
        let items = [];
        
        // Process the folder itself (metadata lives inside it at .flashback)
        // We assume the caller (copy) handled the creation/copying, we just update metadata.
        const folderRel = path.relative(this.workspaceRoot, absPath);
        
        let folderMeta = this.getMetadata(folderRel, true);
        if (!folderMeta) folderMeta = newFolderMetadata(); // Fallback
        
        // REGENERATE IDENTITY
        const oldFolderHash = folderMeta.globalHash;
        folderMeta.globalHash = crypto.randomUUID();
        folderMeta.copiedFrom = oldFolderHash; // distinct from original
        folderMeta.createdAt = new Date().toISOString();
        
        this.writeMetadata(folderRel, folderMeta, true);

        items.push({
            type: 'folder',
            relativePath: folderRel,
            absolutePath: absPath,
            globalHash: folderMeta.globalHash,
            name: path.basename(absPath)
        });

        // Process Children
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        
        for (const entry of entries) {
            // Skip metadata files themselves
            if (entry.name === '.flashback' || entry.name.endsWith('.flashback')) continue;

            const entryAbsPath = path.join(absPath, entry.name);
            const entryRel = path.relative(this.workspaceRoot, entryAbsPath);

            if (entry.isDirectory()) {
                // Recurse
                const childItems = this._regenerateIdentities(entryAbsPath);
                items = items.concat(childItems);
            } else {
                // Process File
                let fileMeta = this.getMetadata(entryRel, false);
                if (!fileMeta) fileMeta = newFileMetadata();

                // REGENERATE IDENTITY
                const oldFileHash = fileMeta.globalHash;
                fileMeta.globalHash = crypto.randomUUID();
                fileMeta.copiedFrom = oldFileHash;
                fileMeta.createdAt = new Date().toISOString();
                // Ensure name matches new filename (if renamed during copy)
                fileMeta.name = entry.name; 

                this.writeMetadata(entryRel, fileMeta, false);

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

    /**
     * Reads the metadata associated with the given relative path.
     * If the path is interpreted as a folder, the metadata path is inside the folder with the name ".flashback".
     * If the path is interpreted as a file, the metadata path is the file path with ".flashback" appended.
     * @param {string} relPath - The relative path for which to read the metadata.
     * @param {boolean} isFolder - Whether the path is interpreted as a folder or a file.
     * @returns {object|null} The read metadata or null if the file does not exist or is malformed.
     */
    getMetadata(relPath, isFolder = false) {
        try {
            const metadataPath = this._metadataPathFor(relPath, isFolder);
            if (!fs.existsSync(metadataPath)) return null;
            const raw = fs.readFileSync(metadataPath, "utf-8");
            return JSON.parse(raw);
        } catch (err) {
            // No swallow: let caller decide; but return null for non-critical malformed metadata
            console.error("Error reading metadata for", relPath, err);
            return null;
        }
    }

    /**
     * Writes the given metadata to the path associated with the given relative path.
     * If isFolder is true, the path is interpreted as a folder and the metadata path is inside the folder with the name ".flashback".
     * If isFolder is false, the path is interpreted as a file and the metadata path is the file path with ".flashback" appended.
     * @param {string} relPath - The relative path for which to write the metadata.
     * @param {object} metadata - The metadata to write.
     * @param {boolean} isFolder - Whether the path is interpreted as a folder or a file.
     */
    writeMetadata(relPath, metadata, isFolder = false) {
        try {
            const metadataPath = this._metadataPathFor(relPath, isFolder);
            // Ensure parent folder exists
            const parent = path.dirname(metadataPath);
            if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
        } catch (err) {
            console.error("Error writing metadata for", relPath, err);
            throw err;
        }
    }


    /**
     * Ensures that the given metadata object has a globalHash property.
     * If the object does not have a globalHash, one is generated using crypto.randomUUID().
     * If the object is not provided, a new object is created using either newFolderMetadata() or newFileMetadata() depending on the value of isFolder.
     * @param {object} [metadata] - The metadata object to ensure has a globalHash property.
     * @param {boolean} [isFolder=false] - Whether the metadata object is associated with a folder or a file.
     * @returns {object} The ensured metadata object with a globalHash property.
     */
    _ensureGlobalHash(metadata, isFolder = false) {
        if (!metadata) metadata = isFolder ? newFolderMetadata() : newFileMetadata();
        if (!metadata.globalHash) {
            // generate a stable unique id once
            metadata.globalHash = crypto.randomUUID();
        }
        return metadata;
    }

    // ---------- FILE OPERATIONS ----------

    /**
     * Creates a new file with the given name at the given relative path.
     * If the file already exists at the given relative path, an error is thrown.
     * The file is created with empty contents.
     * The file's metadata is created and written to the file system.
     * The globalHash of the created file is returned.
     * @param {string} relPath - The relative path to create the file in.
     * @param {string} name - The name of the file to create.
     * @returns {string} The globalHash of the created file.
     * @throws {Error} If the file already exists at the given relative path.
     */
    createFile(relPath, name) {
        const dirResolved = this.safePath(relPath);
        const fileRel = path.join(relPath, name);
        const filePath = this.safePath(fileRel);

        if (this.exists(fileRel)) {
            throw new Error(`File ${name} already exists at ${relPath}`);
        }

        try {
            // ensure parent exists
            if (!fs.existsSync(dirResolved)) fs.mkdirSync(dirResolved, { recursive: true });

            fs.writeFileSync(filePath, ""); // empty file

            let metadata = newFileMetadata();
            metadata = this._ensureGlobalHash(metadata, false);
            metadata.name = name;
            metadata.createdBy = metadata.createdBy || this.config.username || "unknown";
            metadata.createdAt = metadata.createdAt || new Date().toISOString();

            this.writeMetadata(fileRel, metadata, false);

            return metadata.globalHash;
        } catch (err) {
            console.error("Error creating file:", err);
            throw err;
        }
    }

    /**
     * Creates a new folder with the given name at the given relative path.
     * If the folder already exists at the given relative path, an error is thrown.
     * The folder is created with empty contents.
     * The folder's metadata is created and written to the file system.
     * The globalHash of the created folder is returned.
     * @param {string} relPath - The relative path to create the folder in.
     * @param {string} name - The name of the folder to create.
     * @returns {string} The globalHash of the created folder.
     * @throws {Error} If the folder already exists at the given relative path.
     */
    createFolder(relPath, name) {
        const folderRel = path.join(relPath, name);
        const folderPath = this.safePath(folderRel);

        if (this.exists(folderRel)) {
            throw new Error(`Folder ${name} already exists at ${relPath}`);
        }

        try {
            fs.mkdirSync(folderPath, { recursive: true });

            let metadata = newFolderMetadata();
            metadata = this._ensureGlobalHash(metadata, true);
            metadata.name = name;
            metadata.createdBy = metadata.createdBy || this.config.username || "unknown";
            metadata.createdAt = metadata.createdAt || new Date().toISOString();

            this.writeMetadata(folderRel, metadata, true);

            return metadata.globalHash;
        } catch (err) {
            console.error("Error creating folder:", err);
            throw err;
        }
    }

    /**
     * Renames a file or folder at the given relative path to the given new name.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new name, if applicable.
     * @param {string} relPath - The relative path to the item to rename.
     * @param {string} newName - The new name for the item.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     */
    rename(relPath, newName, isFolder = false) {
        // relPath is a path to the item (e.g. "notes/foo.md" or "notes/sub")
        const oldPath = this.safePath(relPath);
        const dirname = path.dirname(relPath);
        const newRel = path.join(dirname, newName);
        const newPath = this.safePath(newRel);

        if (!this.exists(relPath)) throw new Error("Source does not exist");
        if (this.exists(newRel)) throw new Error("Target already exists in destination folder");

        try {
            fs.renameSync(oldPath, newPath);

            // Move metadata if file (sidecar)
            if (!isFolder) {
                const oldMeta = `${oldPath}.flashback`;
                const newMeta = `${newPath}.flashback`;
                if (fs.existsSync(oldMeta)) {
                    fs.renameSync(oldMeta, newMeta);
                } else {
                    // If no sidecar existed (odd), create/update metadata with new name if metadata present elsewhere
                    const meta = this.getMetadata(newRel, false) || newFileMetadata();
                    meta.name = newName;
                    this.writeMetadata(newRel, meta, false);
                }
            } else {
                // For folders, update the internal .flashback name if exists
                const folderMetaPath = path.join(newPath, ".flashback");
                if (fs.existsSync(folderMetaPath)) {
                    try {
                        const m = JSON.parse(fs.readFileSync(folderMetaPath, "utf-8"));
                        m.name = newName;
                        fs.writeFileSync(folderMetaPath, JSON.stringify(m, null, 2), "utf-8");
                    } catch (err) {
                        // ignore but log
                        console.error("Failed updating folder metadata name after rename:", err);
                    }
                }
            }
        } catch (err) {
            console.error("Error renaming:", err);
            throw err;
        }
    }

    /**
     * Moves a file or folder from the given relative path to the given new relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new path, if applicable.
     * @param {string} relPath - The relative path to the item to move.
     * @param {string} newRelPath - The new relative path to move the item to.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     */
    move(relPath, newRelPath, isFolder = false) {
        const oldPath = this.safePath(relPath);
        const newPath = this.safePath(newRelPath);

        if (!this.exists(relPath)) throw new Error("Source does not exist");
        if (this.exists(newRelPath)) throw new Error("Target already exists");

        try {
            // Ensure parent of destination exists
            const destParent = path.dirname(newPath);
            if (!fs.existsSync(destParent)) fs.mkdirSync(destParent, { recursive: true });

            fs.renameSync(oldPath, newPath);

            // Move sidecar if file
            if (!isFolder) {
                const oldMeta = `${oldPath}.flashback`;
                const newMeta = `${newPath}.flashback`;
                if (fs.existsSync(oldMeta)) {
                    fs.renameSync(oldMeta, newMeta);
                }
            } else {
                // If folder move, nothing else required — .flashback moved with folder
            }
        } catch (err) {
            console.error("Error moving:", err);
            throw err;
        }
    }

    /**
     * Deletes a file or folder from the given relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * @param {string} relPath - The relative path to the item to delete.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     */
    delete(relPath, isFolder = false) {
        const target = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("Target does not exist");

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

    /**
     * Copies a file or folder from the given relative path to the given new relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new path, if applicable.
     * The item's identifier is updated to reflect the new path, if applicable.
     * @param {string} relPath - The relative path to the item to copy.
     * @param {string} newRelPath - The new relative path to copy the item to.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     * @returns {string} The globalHash of the copied item (different from the original).
     */
    
    copy(relPath, newRelPath, isFolder = false) {
        const src = this.safePath(relPath);
        const dest = this.safePath(newRelPath);

        if (!this.exists(relPath)) throw new Error("Source does not exist");

        const srcDir = path.dirname(src);
        const destDir = path.dirname(dest);

        try {
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

            let finalDest = dest;

            // Handle name collision (rename if in same folder)
            if (fs.existsSync(dest)) {
                // Auto-rename if collision:
                 if (srcDir === destDir || fs.existsSync(dest)) {
                    const newName = this._resolveCopyName(destDir, path.basename(dest));
                    finalDest = path.join(destDir, newName);
                }
            }

            if (isFolder) {
                // Recursive copy of content and metadata files
                fs.cpSync(src, finalDest, { recursive: true });
                
                // Regenerate Identities and Return List
                // We pass the final destination path
                return this._regenerateIdentities(finalDest);

            } else {
                // Single File Copy
                fs.copyFileSync(src, finalDest);
                
                // Handle Metadata
                const srcMeta = this.getMetadata(relPath, false);
                let newMeta = srcMeta ? structuredClone(srcMeta) : newFileMetadata();
                
                newMeta.globalHash = crypto.randomUUID();
                newMeta.copiedFrom = srcMeta?.globalHash;
                newMeta.name = path.basename(finalDest);
                newMeta.createdAt = new Date().toISOString();
                
                const destRel = path.relative(this.workspaceRoot, finalDest);
                this.writeMetadata(destRel, newMeta, false);

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


/**
 * Updates the content of a file at the given relative path.
 * If the file does not exist at the given relative path, an error is thrown.
 * If the given metadata is not null, the file's metadata is updated with the new values.
 * If the existing metadata has a globalHash, it is preserved in the new metadata.
 * @param {string} relPath - The relative path to the file to update.
 * @param {string} content - The new content of the file.
 * @param {object} [metadata=null] - The new metadata for the file.
 * @param {string} [encoding="utf-8"] - The encoding to use when writing the file.
 * @throws {Error} If the file does not exist at the given relative path.
 * @throws {Error} If there is an error while updating the file or its metadata.
 */
    updateFile(relPath, content, metadata = null, encoding = "utf-8") {
        const filePath = this.safePath(relPath);

        if (!this.exists(relPath)) throw new Error("File does not exist");

        try {
            fs.writeFileSync(filePath, content, { encoding });

            if (metadata) {
                // Ensure globalHash persists
                const existing = this.getMetadata(relPath, false);
                if (existing && existing.globalHash) metadata.globalHash = existing.globalHash;
                this.writeMetadata(relPath, metadata, false);
            }
        } catch (err) {
            console.error("Error updating file:", err);
            throw err;
        }
    }

    /**
     * Adds vanilla data to the file at the given relative path.
     * The given data is written to a file in the "media" subfolder of the file at the given relative path, named with the given name.
     * The file's metadata is updated with the new vanilla data.
     * If the given metadata is not null, the file's metadata is updated with the new values.
     * If the existing metadata has a globalHash, it is preserved in the new metadata.
     * @param {string} anyPath - The relative path to the file to add vanilla data to.
     * @param {Buffer|string} data - The data to write to the file.
     * @param {string} name - The name of the file to write.
     * @param {"sound" | "image"} type - The type of vanilla data to add.
     * @param {"front" | "back"} position - The position of the vanilla data to add.
     * @param {number} cardIndex - The index of the flashcard to add vanilla data to.
     * @param {"binary" | "utf-8"} [encoding="binary"] - The encoding to use when writing the file.
     * @throws {Error} If the file does not exist at the given relative path.
     * @throws {Error} If there is an error while adding the vanilla data or its metadata.
     * @returns {{ mediaPath: string }} The path to the written file.
     */
    addVanillaData(anyPath, data, name, type, position, cardIndex, encoding = "binary") {
        const filePath = this.safePath(anyPath);
        if (!fs.existsSync(filePath)) throw new Error("Parent File does not exist.");

        const mediaDir = path.resolve(path.dirname(filePath), "media");
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

        const mediaPath = path.join(mediaDir, name);

        if (fs.existsSync(mediaPath)) throw new Error("Media file already exists.");

        try {
            fs.writeFileSync(mediaPath, data, { encoding });

            const metadata = this.getMetadata(anyPath);
            if (!metadata || !Array.isArray(metadata.flashcards) || !metadata.flashcards[cardIndex]) {
                // cleanup written media if invalid
                fs.unlinkSync(mediaPath);
                throw new Error(`Flashcard at index ${cardIndex} does not exist.`);
            }

            const targetCard = metadata.flashcards[cardIndex];
            if (!targetCard.vanillaData) targetCard.vanillaData = {};
            if (!targetCard.vanillaData.media) targetCard.vanillaData.media = {};

            if (type === "sound" && position === "front") targetCard.vanillaData.media.frontSound = `./media/${name}`;
            if (type === "sound" && position === "back") targetCard.vanillaData.media.backSound = `./media/${name}`;
            if (type === "image" && position === "front") targetCard.vanillaData.media.frontImg = `./media/${name}`;
            if (type === "image" && position === "back") targetCard.vanillaData.media.backImg = `./media/${name}`;

            this.writeMetadata(anyPath, metadata, false);

            return { mediaPath };
        } catch (err) {
            console.error("Error adding vanilla data:", err);
            throw err;
        }
    }

    /**
     * Adds a custom media file to the given file's flashcard at the given index.
     * If the index is null, the media file is added to the file's metadata instead.
     * @param {string} anyPath - The path to the file to add the media to.
     * @param {Buffer} data - The data of the media file.
     * @param {string} name - The name of the media file.
     * @param {number} [cardIndex=null] - The index of the flashcard to add the media to.
     * @param {string} [encoding="binary"] - The encoding of the data.
     * @returns {object} An object containing the mediaPath and mediaId.
     * @throws {Error} If the file does not exist, the media file already exists, or the flashcard at the given index does not exist.
     */
    addCustomMedia(anyPath, data, name, cardIndex = null, encoding = "binary") {
        const filePath = this.safePath(anyPath);
        if (!fs.existsSync(filePath)) throw new Error("Parent File does not exist.");

        const mediaDir = path.resolve(path.dirname(filePath), "media");
        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

        const mediaPath = path.join(mediaDir, name);
        if (fs.existsSync(mediaPath)) throw new Error("Media file already exists.");

        try {
            fs.writeFileSync(mediaPath, data, { encoding });

            const trimmedName = name.split(".")[0];

            const metadata = this.getMetadata(anyPath);
            if (!metadata || !Array.isArray(metadata.flashcards) || cardIndex === null || !metadata.flashcards[cardIndex]) {
                // cleanup written media if invalid
                fs.unlinkSync(mediaPath);
                throw new Error(`Flashcard at index ${cardIndex} does not exist.`);
            }

            const targetCard = metadata.flashcards[cardIndex];
            if (!targetCard.customData) targetCard.customData = {};
            if (!targetCard.customData.media) targetCard.customData.media = {};

            targetCard.customData.media[trimmedName] = `./media/${name}`;

            this.writeMetadata(anyPath, metadata, false);

            return { mediaPath, mediaId: trimmedName };
        } catch (err) {
            console.error("Error adding custom media:", err);
            throw err;
        }
    }

    /**
     * Removes a custom media file from the given file's flashcard at the given index.
     * If the index is null, the media file is removed from the file's metadata instead.
     * @param {string} anyPath - The path to the file to remove the media from.
     * @param {string} name - The name of the media file.
     * @throws {Error} If the file does not exist, the media file does not exist, or the flashcard at the given index does not exist.
     */
    removeCustomMedia(anyPath, name) {
        const filePath = this.safePath(anyPath);
        if (!fs.existsSync(filePath)) {
            throw new Error("File does not exist.");
        }

        const mediaPath = path.resolve(path.dirname(filePath), "media", name);
        try {
            if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
            // remove references in metadata if present
            const metadata = this.getMetadata(anyPath);
            if (metadata && Array.isArray(metadata.flashcards)) {
                let changed = false;
                for (const card of metadata.flashcards) {
                    if (card.customData && card.customData.media) {
                        for (const key of Object.keys(card.customData.media)) {
                            if (card.customData.media[key] === `./media/${name}`) {
                                delete card.customData.media[key];
                                changed = true;
                            }
                        }
                        // If media object empty, delete it
                        if (Object.keys(card.customData.media).length === 0) delete card.customData.media;
                    }
                    if (card.vanillaData && card.vanillaData.media) {
                        for (const k of ["frontSound", "backSound", "frontImg", "backImg"]) {
                            if (card.vanillaData.media[k] === `./media/${name}`) {
                                delete card.vanillaData.media[k];
                                changed = true;
                            }
                        }
                        if (Object.keys(card.vanillaData.media || {}).length === 0) delete card.vanillaData.media;
                    }
                }
                if (changed) this.writeMetadata(anyPath, metadata, false);
            }
        } catch (err) {
            console.error("Error removing custom media:", err);
            throw err;
        }
    }

    /**
     * Reads the contents of the file at the given relative path.
     * If the file does not exist, an error is thrown.
     * The file's contents are returned as a string, along with the detected encoding.
     * The encoding is detected using chardet, and falls back to utf-8 if chardet is unavailable.
     * @param {string} anyPath - The relative path to the file to read.
     * @returns {object} An object containing the file's contents and the detected encoding.
     * @throws {Error} If the file does not exist.
     */
    readFile(anyPath) {
        const filePath = this.safePath(anyPath);

        if (!fs.existsSync(filePath)) {
            throw new Error("File does not exist.");
        }

        try {
            // detect encoding with chardet, fallback to utf-8
            let encoding = chardet.detectFileSync ? chardet.detectFileSync(filePath, { sampleSize: 64 * 1024 }) : null;
            encoding = encoding || "utf-8";

            const rawBuffer = fs.readFileSync(filePath);

            let content;
            if (iconv.encodingExists(encoding)) {
                content = iconv.decode(rawBuffer, encoding);
            } else {
                console.warn(`Encoding ${encoding} not supported by iconv; falling back to utf-8`);
                content = rawBuffer.toString("utf-8");
            }

            return { content, encoding };
        } catch (err) {
            console.error("Error reading file:", err);
            throw err;
        }
    }

    // ---------- CONVENIENCE ----------

/**
 * Lists all files and folders in the given relative path, excluding the .flashback
 * metadata file.
 * The returned array contains objects with the following properties:
 *   - name: The name of the file or folder.
 *   - type: The type of the file or folder, either "file" or "folder".
 *   - metadata: The metadata of the file or folder, or null if no metadata exists.
 * @param {string} relPath - The relative path to the folder to list.
 * @throws {Error} If the folder does not exist.
 * @returns {Array<object>} An array of objects containing the file or folder's name, type, and metadata.
 */
    listFolder(relPath) {
        const folderPath = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("Folder does not exist");

        return fs
            .readdirSync(folderPath)
            .filter((item) => item !== ".flashback")
            .map((item) => {
                const itemPath = path.join(folderPath, item);
                const isDir = fs.lstatSync(itemPath).isDirectory();
                const meta = this.getMetadata(path.join(relPath, item), isDir);
                return {
                    name: item,
                    type: isDir ? "folder" : "file",
                    metadata: meta,
                };
            });
    }
}
