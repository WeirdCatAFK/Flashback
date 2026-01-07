/* Orchestrator file that makes all the necessary calls to the database and file system Ensuring that both canonical and derived data are updated
Methods are operations that are normally reflected on file explorers, specifically for the flasback data model which manages a tree-like structure
knowledge representation graph.
*/
import path from 'path';
import { get as config } from './config.js';
import Files from './files.js';
import db from './database.js';
import crypto from 'crypto';

export default class Documents {
    constructor() {
        this.config = config();
        this.db = db;
        this.files = new Files();
    }

    // ---------- HELPERS ----------

    /**
     * Create a new node of the given type in the database.
     *
     * @param {string} typeString - The name of the node type (e.g. "folder", "document", etc.).
     * @throws {Error} If the node type is missing.
     * @returns {number} The ID of the newly created node.
     */
    _createNode(typeString) {
        const type = this.db.prepare(`SELECT id FROM NodeTypes WHERE name = ?`).get(typeString);
        if (!type) throw new Error(`${typeString} node type missing.`);

        const info = this.db.prepare(`INSERT INTO Nodes (type_id) VALUES (?)`).run(type.id);
        return info.lastInsertRowid;
    }

    /**
     * Gets the ID of the parent folder of the given absolute path.
     * If the absolute path is the root folder, creates a new root folder in the database if it does not already exist.
     * @param {string} absolutePath - The absolute path of the folder or file.
     * @returns {number|null} The ID of the parent folder, or null if the folder does not exist in the database.
     */
    _getParentFolderId(absolutePath) {
        const parentDir = path.dirname(absolutePath);
        // Custom behavior for root folder
        if (parentDir === this.files.workspaceRoot) {

            try {
                const rootFolder = this.db.prepare(`SELECT id FROM Folders WHERE absolute_path = ?`).get(parentDir);
                if (rootFolder) return rootFolder.id;

                console.log("Root folder missing in DB. Creating it now...");

                const createRootFolderTransaction = this.db.transaction(() => {

                    // Create the Graph Node first
                    const nodeId = this._createNode('Folder');

                    // Generate metadata for the root
                    const globalHash = crypto.randomUUID();
                    const rootName = path.basename(parentDir);

                    // Insert into Folders table
                    const stmt = this.db.prepare(`
                INSERT INTO Folders 
                (node_id, global_hash, relative_path, absolute_path, name, presence)
                VALUES (?, ?, ?, ?, ?, 0)
            `);

                    const info = stmt.run(nodeId, globalHash, "", parentDir, rootName);
                    return info.lastInsertRowid;
                })
                createRootFolderTransaction();
                console.log("Root folder created successfully.");
            } catch (error) {
                console.error("Error creating root folder:", error);
                throw error;
            }
        }

        // Normal behavior for non-root subfolders
        const folder = this.db.prepare(`SELECT id FROM Folders WHERE absolute_path = ?`).get(parentDir);
        return folder ? folder.id : null;
    }


    _updateFlashcards(data) {
        const { lastRecall, level, tags, category, isCustom, customData, vanillaData } = data;
        tags = tags.join(",");
        
        if (isCustom) {
            
        }
        
    }
    rebuild() {
        // Reads the canonical system to rebuild the database
        // This would recursively listFolder() and sync DB records.
        console.log("Rebuild functionality to be implemented: traversing file tree and syncing DB.");
    }


    /**
     * Checks if a file or folder exists at the given relative path.
     * If derived is true, checks in the database instead of the file system.
     * If isFolder is true, checks if a folder exists at the given relative path.
     * If isFolder is false, checks if a file exists at the given relative path.
     * @param {string} relativePath - The relative path to check for existence.
     * @param {boolean} [derived=false] - Whether to check in the database or the file system.
     * @param {boolean} [isFolder=false] - Whether to check for a folder or a file.
     * @returns {object|null} The result of the check, or null if the item does not exist.
     */
    exists(relativePath, derived = false, isFolder = false) {
        if (derived) {
            if (isFolder) {
                return this.db.prepare(`SELECT id FROM Folders WHERE relative_path = ?`).get(relativePath);
            } else {
                return this.db.prepare(`SELECT id FROM Files WHERE relative_path = ?`).get(relativePath);
            }
        }
        return this.files.exists(relativePath);
    }


    // ---------- File operations ----------

    /**
     * Creates a new file with the given name at the given relative path.
     * If the given relative path is empty, the file is created at the root of the workspace.
     * The file is created with empty contents.
     * The file's metadata is created and written to the file system.
     * The globalHash of the created file is returned.
     * @param {string} name - The name of the file to create.
     * @param {string} [relativePath=""] - The relative path to create the file in.
     * @throws {Error} If there is an error while creating the file or its metadata.
     * @returns {string} The globalHash of the created file.
     */
    createFile(name, relativePath = "") {
        let globalHash = null;
        const fileRelPath = path.join(relativePath, name);

        try {
            // Canonical
            try {
                globalHash = this.files.createFile(relativePath, name);
            } catch (error) {
                console.error("Error creating file on canonical file system:", error);
                throw error;
            }

            // Derived
            try {
                const absolutePath = this.files.safePath(fileRelPath);

                // Transaction to ensure atomicity
                const createDocumentTransaction = this.db.transaction(() => {
                    // Create Node
                    const nodeId = this._createNode('Document');

                    // Find Parent Folder
                    const folderId = this._getParentFolderId(absolutePath);

                    // Insert Document
                    const docStmt = this.db.prepare(`
                    INSERT INTO Documents 
                    (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                    VALUES (?, ?, ?, ?, ?, ?, 0)
                `);

                    docStmt.run(folderId, nodeId, globalHash, fileRelPath, absolutePath, name);
                });

                // Execute the transaction
                createDocumentTransaction();
                console.log("Document created successfully:", name);

            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);

                try {
                    // Delete the created file along with its metadata sidecar
                    this.files.delete(fileRelPath, false);
                    console.log("Rollback successful: File deleted.");
                } catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", fileRelPath, fsError);
                    throw fsError;
                }
                throw dbError;
            }

        } catch (error) {
            console.error("Error in createFile orchestrator:", error);
            throw error;
        }
    }

    /**
     * Creates a new folder with the given name at the given relative path.
     * If the folder already exists at the given relative path, an error is thrown.
     * The folder is created with empty contents.
     * The folder's metadata is created and written to the file system.
     * The globalHash of the created folder is returned.
     * @param {string} name - The name of the folder to create.
     * @param {string} [relativePath=""] - The relative path to create the folder in.
     * @returns {string} The globalHash of the created folder.
     * @throws {Error} If the folder already exists at the given relative path.
     */
    createFolder(name, relativePath = "") {
        let globalHash = null;
        let nodeId = null;

        try {
            // Canonical
            try {
                globalHash = this.files.createFolder(relativePath, name);
            } catch (error) {
                console.error("Canonical createFolder failed:", error);
                throw error;
            }

            // Derived
            try {
                const absolutePath = this.files.safePath(path.join(relativePath, name));
                const folderRelPath = path.join(relativePath, name);

                const createDocumentTransaction = this.db.transaction(() => {
                    // Create Node
                    nodeId = this._createNode('Folder');
                    // Insert Folder
                    const folderStmt = this.db.prepare(`
                    INSERT INTO Folders 
                    (node_id, global_hash, relative_path, absolute_path, name, presence)
                    VALUES (?, ?, ?, ?, ?, 0)
                `);

                    folderStmt.run(nodeId, globalHash, folderRelPath, absolutePath, name);
                    console.log("Folder created successfully:", name);

                })

                createDocumentTransaction();
                console.log("Document created successfully:", name);

            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);

                try {
                    // Delete the folder along with its metadata sidecar
                    this.files.delete(folderRelPath, true);
                    console.log("Rollback successful: Folder deleted.");

                } catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", folderRelPath, fsError);
                    throw fsError;
                }
                throw dbError;
            }
        } catch (error) {
            console.error("Error in createFolder orchestrator:", error);
        }
    }

    /**
     * Renames a file or folder at the given relative path to the given new name.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new name, if applicable.
     * The item's identifier is updated to reflect the new name, if applicable.
     * @param {string} relativePath - The relative path to the item to rename.
     * @param {string} newName - The new name for the item.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     */
    rename(relativePath, newName, isFolder = false) {
        try {
            const oldAbsPath = this.files.safePath(relativePath);
            const oldName = path.basename(relativePath);

            // Canonical
            try {
                this.files.rename(relativePath, newName, isFolder);
            } catch (fsError) {
                console.error("Canonical rename failed:", fsError);
                throw fsError;
            }
            // Derived
            try {
                const parentDir = path.dirname(relativePath);
                const newRelPath = path.join(parentDir, newName);
                const newAbsPath = this.files.safePath(newRelPath);

                const table = isFolder ? 'Folders' : 'Documents';
                // Update specific item
                const updateNameTransaction = this.db.transaction(() => {
                    const stmt = this.db.prepare(`
                UPDATE ${table} 
                SET name = ?, relative_path = ?, absolute_path = ?
                WHERE absolute_path = ?
                `);
                    stmt.run(newName, newRelPath, newAbsPath, oldAbsPath);
                })
                updateNameTransaction();
                console.log('Name updated successfully:', newName);
                // Update children
                if (isFolder) {
                    const updateChildrenTransaction = this.db.transaction(() => {
                        // Update Documents inside this folder
                        this.db.prepare(`
                    UPDATE Documents 
                    SET relative_path = replace(relative_path, ?, ?),
                        absolute_path = replace(absolute_path, ?, ?)
                    WHERE absolute_path LIKE ? || '%'
                 `).run(relativePath, newRelPath, oldAbsPath, newAbsPath, oldAbsPath);

                        // Update Sub-Folders inside this folder
                        this.db.prepare(`
                    UPDATE Folders
                    SET relative_path = replace(relative_path, ?, ?),
                        absolute_path = replace(absolute_path, ?, ?)
                    WHERE absolute_path LIKE ? || '%'
                 `).run(relativePath, newRelPath, oldAbsPath, newAbsPath, oldAbsPath);
                    })
                    updateChildrenTransaction();
                    console.log('Children paths updated successfully');
                }
            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);
                try {
                    this.files.rename(oldName, newRelPath, isFolder);
                }
                catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", relativePath, fsError);
                }
                throw dbError;
            }
        } catch (error) {
            console.error("Error renaming:", error);
        }
    }

    /**
     * Moves a file or folder from the given relative path to the given new relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * If the item already exists at the given relative path with the new name, an error is thrown.
     * The item's metadata is updated to reflect the new path, if applicable.
     * The item's identifier is updated to reflect the new path, if applicable.
     * @param {string} relativePath - The relative path to the item to move.
     * @param {string} newRelativePath - The new relative path to move the item to.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     * @throws {Error} If the item already exists at the given relative path with the new name.
     */
    move(relativePath, newRelativePath, isFolder = false) {
        try {
            const oldAbsPath = this.files.safePath(relativePath);
            // Canonical
            try {
                this.files.move(relativePath, newRelativePath, isFolder);
            } catch (fsError) {
                console.error("Canonical move failed:", fsError);
                throw fsError;
            }
            // Derived
            try {
                const moveTransaction = this.db.transaction(() => {
                    const newAbsPath = this.files.safePath(newRelativePath);
                    // Calculate new parent id for Documents
                    let newFolderId = null;
                    // File 
                    if (!isFolder) {
                        newFolderId = this._getParentFolderId(newAbsPath);
                    }
                    // Update the moved item
                    if (!isFolder) {
                        const stmt = this.db.prepare(`
                    UPDATE Documents
                    SET folder_id = ?, relative_path = ?, absolute_path = ?
                    WHERE absolute_path = ?
                `);
                        stmt.run(newFolderId, newRelativePath, newAbsPath, oldAbsPath);
                    } else {
                        // Folder
                        const stmt = this.db.prepare(`
                    UPDATE Folders
                    SET relative_path = ?, absolute_path = ?
                    WHERE absolute_path = ?
                `);
                        stmt.run(newRelativePath, newAbsPath, oldAbsPath);

                        // Cascade update children paths (similar to rename)
                        this.db.prepare(`
                    UPDATE Documents 
                    SET relative_path = replace(relative_path, ?, ?),
                        absolute_path = replace(absolute_path, ?, ?)
                    WHERE absolute_path LIKE ? || '%'
                 `).run(relativePath, newRelativePath, oldAbsPath, newAbsPath, oldAbsPath);

                        this.db.prepare(`
                    UPDATE Folders
                    SET relative_path = replace(relative_path, ?, ?),
                        absolute_path = replace(absolute_path, ?, ?)
                    WHERE absolute_path LIKE ? || '%'
                 `).run(relativePath, newRelativePath, oldAbsPath, newAbsPath, oldAbsPath);
                    }
                })
                moveTransaction();
            } catch (dbError) {
                console.error("Error updating database. Initiating rollback...", dbError);
                try {
                    this.files.move(newRelativePath, relativePath, isFolder);
                }
                catch (fsError) {
                    console.error("CRITICAL: Rollback failed. Orphaned file at:", newRelativePath, fsError);
                }
                throw dbError;
            }
        } catch (error) {
            console.error("Error moving:", error);
        }
    }

    /**
     * Deletes a file or folder from the given relative path.
     * If the item does not exist at the given relative path, an error is thrown.
     * @param {string} relPath - The relative path to the item to delete.
     * @param {boolean} [isFolder=false] - Whether the item is a folder or not.
     * @throws {Error} If the item does not exist at the given relative path.
     */
    delete(relativePath, isFolder = false) {
        try {
            const absPath = this.files.safePath(relativePath);

            // Canonical
            try {
                this.files.delete(relativePath, isFolder);
            } catch (fsError) {
                console.error("Canonical delete failed. Aborting DB delete.", fsError);
                throw fsError;
            }

            // Derived
            try {
                const deleteTransaction = this.db.transaction(() => {
                    // Safe prefix to match children.
                    // path.sep ensures we don't accidentally match folders with similar names
                    // e.g. deleting "/data/test" should not delete "/data/test_backup"
                    const childPrefix = absPath + path.sep;

                    // Matches the exact item if it's a file or any file inside the folder tree
                    const deletedDocs = this.db.prepare(`
                        DELETE FROM Documents 
                        WHERE absolute_path = ? OR absolute_path LIKE ? || '%'
                        RETURNING node_id
                    `).all(absPath, childPrefix);

                    // Delete Folders only if the target itself is a folder
                    let deletedFolders = [];
                    if (isFolder) {
                        deletedFolders = this.db.prepare(`
                            DELETE FROM Folders 
                            WHERE absolute_path = ? OR absolute_path LIKE ? || '%'
                            RETURNING node_id
                        `).all(absPath, childPrefix);
                    }

                    // Cleanup Nodes
                    // We collect all node_ids returned by the DELETE operations above
                    const allNodeIds = [
                        ...deletedDocs.map(d => d.node_id),
                        ...deletedFolders.map(f => f.node_id)
                    ];

                    // Remove them from the graph
                    if (allNodeIds.length > 0) {
                        const deleteNodeStmt = this.db.prepare('DELETE FROM Nodes WHERE id = ?');
                        for (const nodeId of allNodeIds) {
                            deleteNodeStmt.run(nodeId);
                        }
                    }

                    console.log(`Derived delete complete. Removed ${allNodeIds.length} entities.`);
                });
                deleteTransaction();

            } catch (dbError) {
                console.error("CRITICAL: Error deleting from file from database. orphaned entries may exist.", dbError);
                throw dbError;
            }

        } catch (error) {
            console.error("Error deleting:", error);
            throw error;
        }
    }

    copy(relativePath, newRelativePath, isFolder = false) {
        let newItems = [];
        try {
            // Canonical
            try {
                // Copy and get list of ALL new items (re-hashed)
                newItems = this.files.copy(relativePath, newRelativePath, isFolder);
            } catch (fsError) {
                console.error("Canonical copy failed. Aborting DB copy.", fsError);
                throw fsError;
            }

            // Derived
            try {
                if (newItems && newItems.length > 0) {
                    const copyTransaction = this.db.transaction(() => {

                        // Sort items by path length. 
                        // This ensures folders are processed before their children.
                        newItems.sort((a, b) => a.absolutePath.length - b.absolutePath.length);

                        // Cache for folder IDs created in this transaction
                        // Map<AbsolutePath, FolderID>
                        const folderIdCache = new Map();

                        for (const item of newItems) {
                            // Create Graph Node
                            const nodeType = item.type === 'folder' ? 'Folder' : 'Document';
                            const nodeId = this._createNode(nodeType);

                            if (item.type === 'folder') {
                                // Insert Folder
                                const stmt = this.db.prepare(`
                                INSERT INTO Folders 
                                (node_id, global_hash, relative_path, absolute_path, name, presence)
                                VALUES (?, ?, ?, ?, ?, 0)
                            `);
                                const info = stmt.run(nodeId, item.globalHash, item.relativePath, item.absolutePath, item.name);

                                // Cache ID for children to use
                                folderIdCache.set(item.absolutePath, info.lastInsertRowid);

                            } else {
                                // Insert Document
                                // Find parent folder ID and check cache first (for parents created in this specific copy operation)
                                const parentPath = path.dirname(item.absolutePath);
                                let folderId = folderIdCache.get(parentPath);

                                // If not in cache, check DB (it might be the root of the copy target)
                                if (!folderId) {
                                    folderId = this._getParentFolderId(item.absolutePath);
                                }

                                const stmt = this.db.prepare(`
                                INSERT INTO Documents 
                                (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                                VALUES (?, ?, ?, ?, ?, ?, 0)
                            `);
                                stmt.run(folderId, nodeId, item.globalHash, item.relativePath, item.absolutePath, item.name);
                            }
                        }
                    });

                    copyTransaction();
                    console.log(`Copy successful. Created ${newItems.length} new items.`);
                }
            } catch (dbError) {
                console.error("CRITICAL: Error copying info to database. Initiating rollback...", dbError);
                try {
                    this.delete(newItems[0].relativePath);
                } catch (fsError) {
                    console.error("Error rolling back disk changes, there may be orphaned files:", fsError);
                }

                throw dbError;
            }
        } catch (error) {
            console.error("Error copying:", error);
            throw error;
        }
    }

    updateFile(relativePath, content, metadata = null, encoding = "utf-8") {
        try {
            // Canonical
            try {
                this.files.updateFile(relativePath, content, metadata, encoding);
            }
            catch (fsError) {
                console.error("Error updating file:", fsError);
                throw fsError;
            }

            // Derived
            try {
                // So we assume that we are receiving a json update
                const updateTransaction = this.db.transaction(() => {
                    const tags = metadata.tags;
                    const excludedTags = metadata.excludedTags;
                    const flashcards = metadata.flashcards;

                })

            } catch (dbError) {
                console.error("Error updating file:", dbError);
                throw dbError;
            }


            // 2. Derived
            // Content update might require re-parsing flashcards.
            // For now, we might just update a 'last_modified' or presence if tracked.
            // If the content change affects metadata (e.g. JSON update), we should parse it.
            // Assuming this is a text update:
            console.log("File content updated. Re-scan required for flashcards.");
        } catch (error) {
            console.error("Error updating file:", error);
        }
    }
    /**
         * Imports a file by creating it and immediately writing its content.
         * Rollbacks (deletes) the file if the content write or DB insert fails.
         */
    importFile(name, relativePath, content) {
        const fileRelPath = path.join(relativePath, name);
        let globalHash = null;

        try {
            // 1. Canonical: Create Empty File
            // We must do this first to generate the metadata and reserve the name
            try {
                globalHash = this.files.createFile(relativePath, name);
            } catch (error) {
                console.error("Import failed: Could not create file:", error);
                throw error;
            }

            // 2. Canonical: Write Actual Content
            // If this fails, we must delete the empty file we just created
            try {
                this.files.updateFile(fileRelPath, content);
            } catch (writeError) {
                console.error("Import failed: Could not write content. Rolling back...", writeError);
                this.files.delete(fileRelPath, false); // Rollback
                throw writeError;
            }

            // 3. Derived: Update Database
            // If this fails, we must delete the file (now containing data)
            try {
                const absolutePath = this.files.safePath(fileRelPath);

                const importTransaction = this.db.transaction(() => {
                    const nodeId = this._createNode('Document');
                    const folderId = this._getParentFolderId(absolutePath);

                    const docStmt = this.db.prepare(`
                        INSERT INTO Documents 
                        (folder_id, node_id, global_hash, relative_path, absolute_path, name, presence)
                        VALUES (?, ?, ?, ?, ?, ?, 0)
                    `);

                    docStmt.run(folderId, nodeId, globalHash, fileRelPath, absolutePath, name);
                });

                importTransaction();
                console.log("File imported successfully:", name);

            } catch (dbError) {
                console.error("Import failed: Database error. Rolling back...", dbError);
                this.files.delete(fileRelPath, false); // Rollback
                throw dbError;
            }

        } catch (error) {
            console.error("Error in importFile orchestrator:", error);
            throw error; // Rethrow so UI can show "Import Failed"
        }
    }
    updateMetadata(relativePath, metadata, isFolder = false) {
        try {
            // 1. Canonical
            this.files.writeMetadata(relativePath, metadata, isFolder);

            // 2. Derived
            // Update specific columns derived from metadata (like tags, presence, global_hash if changed)
            // This requires mapping JSON metadata fields to DB columns.
        } catch (error) {
            console.error("Error updating metadata:", error);
        }
    }
}