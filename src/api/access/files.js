/* 
 A bridge for the operations of the flashback canonical data system.
 Default: all file operations are handled inside the flashback directory at userData.
 If the config provides a custom path it will be used instead to mount files elsewhere.
*/

import { get as config } from './config';
import FlashbackFileTemplate from './../config/defaults/FlashbackFile.js';
import FlashbackFolderTemplate from './../config/defaults/FlashbackFolder';
import path from 'path';
import fs from 'fs';

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

    safePath(relPath) {
        const resolved = path.resolve(this.workspaceRoot, relPath);
        if (!resolved.startsWith(this.workspaceRoot)) {
            throw new Error("Path traversal outside of workspace is not allowed");
        }
        return resolved;
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

    createFile(relPath, name, overwrite = false) {
        const filePath = this.safePath(path.join(relPath, name));
        if (this.exists(path.join(relPath, name)) && !overwrite) {
            throw new Error(`File ${name} already exists`);
        }

        const metadata = FlashbackFileTemplate.copy();
        metadata.globalHash = this.globalHash(name);

        try {
            fs.writeFileSync(filePath, ""); // empty file
            this.writeMetadata(path.join(relPath, name), metadata, false);
        } catch (error) {
            console.error("Error creating file:", error);
        }
    }

    createFolder(relPath, name, overwrite = false) {
        const folderPath = this.safePath(path.join(relPath, name));
        if (this.exists(path.join(relPath, name)) && !overwrite) {
            throw new Error(`Folder ${name} already exists`);
        }

        const metadata = FlashbackFolderTemplate.copy();
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

            // Move metadata file
            if (isFolder) {
                fs.renameSync(
                    path.join(oldPath, ".flashback"),
                    path.join(newPath, ".flashback")
                );
            } else {
                fs.renameSync(oldPath + ".flashback", newPath + ".flashback");
            }
        } catch (error) {
            console.error("Error renaming:", error);
        }
    }

    move(relPath, newRelPath, isFolder = false) {
        const oldPath = this.safePath(relPath);
        const newPath = this.safePath(newRelPath);

        if (!this.exists(relPath)) throw new Error("Source does not exist");

        try {
            fs.renameSync(oldPath, newPath);

            if (isFolder) {
                fs.renameSync(
                    path.join(oldPath, ".flashback"),
                    path.join(newPath, ".flashback")
                );
            } else {
                fs.renameSync(oldPath + ".flashback", newPath + ".flashback");
            }
        } catch (error) {
            console.error("Error moving:", error);
        }
    }

    delete(relPath, isFolder = false) {
        const target = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("Target does not exist");

        try {
            if (isFolder) {
                fs.rmSync(target, { recursive: true, force: true });
            } else {
                fs.unlinkSync(target);
            }
            // Delete metadata file
            if (isFolder) {
                fs.unlinkSync(path.join(target, ".flashback"));
            } else {
                fs.unlinkSync(target + ".flashback");
            }
        } catch (error) {
            console.error("Error deleting:", error);
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

    // ---------- CONVENIENCE ----------

    readFile(relPath, encoding = "utf-8") {
        const filePath = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("File does not exist");

        return fs.readFileSync(filePath, { encoding });
    }

    listFolder(relPath) {
        const folderPath = this.safePath(relPath);
        if (!this.exists(relPath)) throw new Error("Folder does not exist");

        return fs.readdirSync(folderPath).map(item => {
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
