/* 
 A bridge for the operations of the flashback canonical data system.
 Default: all file operations are handled inside the flashback directory at userData.
 If the config provides a custom path it will be used instead to mount files elsewhere.

 Some rules to be aware of:
 Since the system uses a derived data system, the file reads are done at the document.js level
 The canonical data system is a group of jsons with metadata and a media file at root level of folders
 The canonical data makes all writes to the file system, document.js makes all writes to the database


*/

import { get as config } from './config';
import newFileMetadata from './../config/defaults/FlashbackFile.js';
import newFolderMetadata from './../config/defaults/FlashbackFolder';
import path from 'path';
import fs from 'fs';
import iconv from 'iconv-lite'

export default class Files {
    constructor() {
        this.config = config();

        if (this.config.isCustomPath) {
            if (path.isAbsolute(this.config.customPath)) {
                this.workspaceRoot = this.config.customPath;
            } else {
                throw new Error("Custom path provided is not absolute");
            }
        } else {
            this.workspaceRoot = path.join(process.env.USER_DATA_PATH, "workspace");
        }

        if (!fs.existsSync(this.workspaceRoot)) {
            fs.mkdirSync(this.workspaceRoot, { recursive: true });
        }
    }

    // ---------- HELPERS ----------

    safePath(anyPath) {
        const resolvedPath = path.resolve(this.workspaceRoot, anyPath);
        const rel = path.relative(this.workspaceRoot, resolvedPath);

        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error("Path traversal outside of workspace is not allowed");
        }

        return resolvedPath;
    }

    exists(relPath) {
        return fs.existsSync(this.safePath(relPath));
    }

    getMetadata(relPath, isFolder = false) {
        try {
            const metadataPath = isFolder
                ? path.join(this.safePath(relPath), ".flashback")
                : this.safePath(relPath) + ".flashback";
            if (!fs.existsSync(metadataPath)) return null;
            return JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        } catch {
            return null;
        }
    }

    writeMetadata(relPath, metadata, isFolder = false) {
        const metadataPath = isFolder
            ? path.join(this.safePath(relPath), ".flashback")
            : this.safePath(relPath) + ".flashback";
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    }

    globalHash(name, username = this.config.username, date = new Date(), isFolder = false) {
        // Placeholder until network hash is available
        return `${isFolder ? "folder" : "file"}-${username}-${name}-${date.getTime()}`;
    }

    // ---------- FILE OPERATIONS ----------

    createFile(relPath, name) {
        const filePath = this.safePath(path.join(relPath, name));
        if (this.exists(path.join(relPath, name))) {
            throw new Error(`File ${name} already exists`);
        }

        const metadata = newFileMetadata()
        metadata.globalHash = this.globalHash(name);
        try {
            fs.writeFileSync(filePath, ""); // empty file
            this.writeMetadata(path.join(relPath, name), metadata, false);
        } catch (error) {
            console.error("Error creating file:", error);
        }
        console.log("File created successfully");
        return metadata.globalHash;

    }

    createFolder(relPath, name) {
        const folderPath = this.safePath(path.join(relPath, name));
        if (this.exists(path.join(relPath, name))) {
            throw new Error(`Folder ${name} already exists`);
        }

        const metadata = newFolderMetadata()
        metadata.globalHash = this.globalHash(name, this.config.username, new Date(), true);

        try {
            fs.mkdirSync(folderPath, { recursive: true });
            this.writeMetadata(path.join(relPath, name), metadata, true);
        } catch (error) {
            console.error("Error creating folder:", error);
        }
    }

    rename(relPath, newName, isFolder = false) {
        const oldPath = this.safePath(relPath);
        const newPath = path.join(path.dirname(oldPath), newName);

        if (!this.exists(relPath)) throw new Error("Source does not exist");
        if (this.exists(newName)) throw new Error("Target already exists");

        try {
            fs.renameSync(oldPath, newPath);

            // 2. Handle metadata (ONLY necessary for files)
            // If it's a folder, the metadata inside moved with it automatically.
            if (!isFolder) {
                const oldMeta = oldPath + ".flashback";
                const newMeta = newPath + ".flashback";
                if (fs.existsSync(oldMeta)) {
                    fs.renameSync(oldMeta, newMeta);
                }
            }
        } catch (error) {
            console.error("Error renaming:", error);
            throw error; // Re-throw so the UI handles it
        }
    }

    move(relPath, newRelPath, isFolder = false) {
        const oldPath = this.safePath(relPath);
        const newPath = this.safePath(newRelPath);

        if (!this.exists(relPath)) throw new Error("Source does not exist");

        try {

            fs.renameSync(oldPath, newPath);

            if (!isFolder) {
                const oldMeta = oldPath + ".flashback";
                const newMeta = newPath + ".flashback";

                // Check if metadata exists before trying to move it
                if (fs.existsSync(oldMeta)) {
                    fs.renameSync(oldMeta, newMeta);
                }
            }
        } catch (error) {
            console.error("Error moving:", error);
            throw error; // Important: Throw so the UI knows it failed
        }
    }

    delete(relPath, isFolder = false) {
        const target = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("Target does not exist");

        try {
            if (isFolder) {
                // Recursive delete removes the folder AND the internal .flashback file
                fs.rmSync(target, { recursive: true, force: true });
            } else {
                // Delete file
                fs.unlinkSync(target);
                // Delete sidecar metadata
                const metaPath = target + ".flashback";
                if (fs.existsSync(metaPath)) {
                    fs.unlinkSync(metaPath);
                }
            }
        } catch (error) {
            console.error("Error deleting:", error);
            throw error;
        }
    }

    copy(relPath, newRelPath, isFolder = false) {
        const src = this.safePath(relPath);
        const dest = this.safePath(newRelPath);

        if (!this.exists(relPath)) throw new Error("Source does not exist");

        try {
            if (isFolder) {
                fs.cpSync(src, dest, { recursive: true });
            } else {
                fs.copyFileSync(src, dest);
                fs.copyFileSync(src + ".flashback", dest + ".flashback");
            }
        } catch (error) {
            console.error("Error copying:", error);
        }
    }

    updateFile(relPath, content, metadata = null, encoding = "utf-8") {
        const filePath = this.safePath(relPath);

        if (!this.exists(relPath)) throw new Error("File does not exist");

        try {
            fs.writeFileSync(filePath, content, { encoding });

            if (metadata) {
                this.writeMetadata(relPath, metadata, false);
            }
        } catch (error) {
            console.error("Error updating file:", error);
        }
    }



    addVanillaData(anyPath, data, name, type, position, cardIndex, encoding = "binary") {
        const filePath = this.safePath(anyPath);
        if (!fs.existsSync(filePath)) throw new Error('Parent File does not exist.');

        const mediaPath = path.resolve(path.dirname(filePath), 'media', name);

        if (fs.existsSync(mediaPath)) throw new Error('Media file already exists.');

        fs.writeFileSync(mediaPath, data, { encoding });

        const metadata = this.getMetadata(anyPath);

        if (!metadata.flashcards || !metadata.flashcards[cardIndex]) throw new Error(`Flashcard at index ${cardIndex} does not exist.`);

        const targetCard = metadata.flashcards[cardIndex];

        if (!targetCard.vanillaData) targetCard.vanillaData = {};
        if (!targetCard.vanillaData.media) targetCard.vanillaData.media = {};

        if (type === 'sound' && position === 'front') targetCard.vanillaData.media.frontSound = "./media/" + name;
        if (type === 'sound' && position === 'back') targetCard.vanillaData.media.backSound = "./media/" + name;
        if (type === 'image' && position === 'front') targetCard.vanillaData.media.frontImg = "./media/" + name;
        if (type === 'image' && position === 'back') targetCard.vanillaData.media.backImg = "./media/" + name;

        this.writeMetadata(anyPath, metadata, false);
        return {
            mediaPath: mediaPath
        }
    }


    addCustomMedia(anyPath, data, name, cardIndex = null, encoding = "binary") {
        const filePath = this.safePath(anyPath);

        if (!fs.existsSync(filePath)) throw new Error('Parent File does not exist.');

        const mediaPath = path.resolve(path.dirname(filePath), 'media', name);

        if (fs.existsSync(mediaPath)) throw new Error('Media file already exists.');

        fs.writeFileSync(mediaPath, data, { encoding });

        const trimmedName = name.split('.')[0];

        const metadata = this.getMetadata(anyPath);

        if (!metadata.flashcards || !metadata.flashcards[cardIndex]) throw new Error(`Flashcard at index ${cardIndex} does not exist.`);

        const targetCard = metadata.flashcards[cardIndex];

        if (!targetCard.customData) targetCard.customData = {};
        if (!targetCard.customData.media) targetCard.customData.media = {};

        targetCard.customData.media[trimmedName] = `./media/${name}`;

        this.writeMetadata(anyPath, metadata, false);

        return {
            mediaPath: mediaPath,
            mediaId: trimmedName
        };
    }
    removeCustomMedia(anyPath, name) {
        const filePath = this.safePath(anyPath);
        if (!fs.existsSync(filePath)) {
            throw new Error('File does not exist.');
        }
        const mediaPath = path.resolve(path.dirname(filePath), 'media', name)
        if (!fs.existsSync(mediaPath)) {

        }

    }
    // Only retrieves the file content
    readFile(anyPath) {
        const filePath = this.safePath(anyPath);

        if (!fs.existsSync(filePath)) {
            throw new Error('File does not exist.');
        }
        const encoding = chardet.detectFileSync(filePath, { sampleSize: 64 * 1024 }) || 'utf-8';

        const rawBuffer = fs.readFileSync(filePath);

        let content;

        if (iconv.encodingExists(encoding)) {
            content = iconv.decode(rawBuffer, encoding);
        } else {
            // If iconv doesn't know it, fallback to utf-8 string or throw error
            console.warn(`Encoding ${encoding} not supported, falling back to UTF-8`);
            content = rawBuffer.toString('utf-8');

        }
        return {
            content: content,
            encoding: encoding

        };
    }
    // ---------- CONVENIENCE ----------

    listFolder(relPath) {
        const folderPath = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("Folder does not exist");

        return fs.readdirSync(folderPath)
            // FILTER OUT the system file
            .filter(item => item !== '.flashback')
            .map(item => {
                const itemPath = path.join(folderPath, item);
                const isDir = fs.lstatSync(itemPath).isDirectory();
                return {
                    name: item,
                    type: isDir ? "folder" : "file",
                    metadata: this.getMetadata(path.join(relPath, item), isDir)
                };
            });
    }


}
